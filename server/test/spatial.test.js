import test from "node:test";
import assert from "node:assert/strict";

import { findGridPath, spatialQuery } from "../../module/scripts/spatial.js";

// A vertical wall at x=300 from y=0 to y=300 (grid 100): rows 0-2 are cut, row 3 is open.
const wallAt300 = {
  testCollision(a, b) {
    const crosses = (a.x - 300) * (b.x - 300) < 0;
    const y = a.y + (b.y - a.y) * ((300 - a.x) / (b.x - a.x));
    return crosses && y < 300;
  },
};

test("findGridPath routes around a wall, gives up at maxNodes, returns null when enclosed", () => {
  const r = findGridPath({ startX: 100, startY: 100, endX: 500, endY: 100, gridSize: 100, collision: wallAt300 });
  assert.ok(r.path.some((p) => p.y >= 300), "goes under the wall");
  assert.deepEqual(r.path.at(-1), { x: 500, y: 100 });
  assert.equal(r.cost, r.path.length);
  const capped = findGridPath({ startX: 100, startY: 100, endX: 500, endY: 100, gridSize: 100, collision: wallAt300, maxNodes: 2 });
  assert.deepEqual(capped, { path: [], cost: 0, capped: true });
  const boxed = { testCollision: () => true };
  assert.equal(findGridPath({ startX: 0, startY: 0, endX: 500, endY: 0, gridSize: 100, collision: boxed }), null);
});

function fakeCanvas() {
  const tokens = [
    { id: "a", name: "Alpha", actorId: "x", center: { x: 150, y: 150 }, x: 100, y: 100, width: 1, height: 1 },
    { id: "b", name: "Beyond", actorId: "y", center: { x: 550, y: 150 } },
    { id: "n", name: "Near", actorId: "z", center: { x: 150, y: 350 } },
  ].map((t) => ({ ...t, getCenterPoint: () => t.center }));
  Object.assign(tokens, { get: (id) => tokens.find((t) => t.id === id) });
  const scene = {
    id: "s1",
    tokens,
    grid: {
      size: 100, units: "ft", diagonals: 0,
      measurePath: (pts) => {
        let d = 0;
        for (let i = 1; i < pts.length; i++) d += Math.max(Math.abs(pts[i].x - pts[i - 1].x), Math.abs(pts[i].y - pts[i - 1].y)) / 20;
        return { distance: d, cost: d, spaces: d / 5, diagonals: 0, euclidean: d };
      },
    },
  };
  // Each backend answers testCollision like core: "any" → boolean, "all" → vertices carrying edges.
  const backend = {
    testCollision: (a, b, { mode, type }) => {
      const hit = wallAt300.testCollision(a, b) && type !== "sound";
      if (mode === "any") return hit;
      return hit ? [{ x: 300, y: 150, edges: new Set([{ type: "wall", id: "wall.W1" }, { type: "innerBounds", id: "b" }]) }] : [];
    },
  };
  globalThis.canvas = { ready: true, scene };
  globalThis.CONFIG = { Canvas: { polygonBackends: { move: backend, sight: backend, light: backend, sound: backend } } };
  globalThis.CONST = { GRID_DIAGONALS: { EQUIDISTANT: 0, EXACT: 1 } };
  globalThis.game = { scenes: { get: () => undefined, active: scene } };
  return scene;
}

test("collision: per type, wall ids only, first contact point", () => {
  fakeCanvas();
  const r = spatialQuery({ mode: "collision", from: "Alpha", to: { x: 550, y: 150 } });
  assert.deepEqual(r.move, { blocked: true, walls: ["W1"], at: { x: 300, y: 150 } });
  assert.deepEqual(r.sound, { blocked: false, walls: [] });
  assert.deepEqual(Object.keys(spatialQuery({ mode: "collision", from: "Alpha", to: "Beyond", types: ["sight"] })), ["mode", "from", "to", "level", "sight"]);
  assert.throws(() => spatialQuery({ mode: "collision", from: "Ghost", to: "Alpha" }), /from: token not found: Ghost/);
});

test("range: nearest first, lineOfSight drops tokens behind a sight wall, self excluded", () => {
  fakeCanvas();
  const all = spatialQuery({ mode: "range", from: "Alpha", distance: 30 });
  assert.deepEqual(all.tokens.map((t) => [t.name, t.distance]), [["Near", 10], ["Beyond", 20]]);
  const los = spatialQuery({ mode: "range", from: "Alpha", distance: 30, lineOfSight: true });
  assert.deepEqual(los.tokens.map((t) => t.name), ["Near"]);
  assert.throws(() => spatialQuery({ mode: "range", from: "Alpha" }), /range needs distance/);
});

test("path: waypoints, steps and distance through measurePath; maxNodes bounds", () => {
  fakeCanvas();
  const r = spatialQuery({ mode: "path", from: "Alpha", to: { x: 550, y: 150 } });
  assert.equal(r.reachable, true);
  assert.equal(r.steps, r.waypoints.length);
  assert.deepEqual(r.waypoints.at(-1), { x: 500, y: 100, gx: 5, gy: 1 });
  assert.equal(typeof r.distance, "number");
  assert.match(spatialQuery({ mode: "path", from: "Alpha", to: { x: 550, y: 150 }, maxNodes: 1 }).reason, /Gave up after 1 cells/);
  assert.throws(() => spatialQuery({ mode: "path", from: "Alpha", to: { x: 0, y: 0 }, maxNodes: 10_001 }), /maxNodes must be/);
});

test("measure: names the diagonal rule; needs no drawn canvas", () => {
  const scene = fakeCanvas();
  globalThis.canvas = { ready: false, scene: null };
  globalThis.game = { scenes: { get: (id) => (id === "s1" ? scene : undefined), active: null } };
  const r = spatialQuery({ mode: "measure", sceneId: "s1", waypoints: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }] });
  assert.deepEqual([r.distance, r.units, r.diagonalRule], [15, "ft", "equidistant"]);
  assert.throws(() => spatialQuery({ mode: "measure", sceneId: "s1", waypoints: [{ x: 0, y: 0 }] }), /at least two/);
  assert.throws(() => spatialQuery({ mode: "path", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }), /View the scene first/);
  assert.throws(() => spatialQuery({ mode: "fly" }), /Unknown query_grid mode "fly"/);
});

test("path/collision/range test the walls of the from token's Level, an explicit level, or the canvas Level", () => {
  const scene = fakeCanvas();
  const levels = [{ id: "L1", name: "Cellar" }, { id: "L2", name: "Ground" }];
  scene.name = "Test";
  scene.levels = Object.assign(levels, { get: (id) => levels.find((l) => l.id === id), getName: (n) => levels.find((l) => l.name === n) });
  scene.initialLevel = levels[0];
  scene.tokens.get("a")._source = { level: "L2" };
  scene.tokens.get("n")._source = { level: "gone" };
  globalThis.canvas.level = levels[0];
  const seen = [];
  for (const b of Object.values(CONFIG.Canvas.polygonBackends)) {
    const inner = b.testCollision;
    b.testCollision = (x, y, opts) => { seen.push(opts.level?.id); return inner(x, y, opts); };
  }
  const run = (q) => { seen.length = 0; const r = spatialQuery(q); return [r.level, [...new Set(seen)]]; };
  assert.deepEqual(run({ mode: "collision", from: "Alpha", to: { x: 550, y: 150 } }), ["L2", ["L2"]]);
  assert.deepEqual(run({ mode: "collision", from: { x: 150, y: 150 }, to: { x: 550, y: 150 } }), ["L1", ["L1"]]);
  assert.deepEqual(run({ mode: "range", from: "Alpha", distance: 30, lineOfSight: true }), ["L2", ["L2"]]);
  assert.deepEqual(run({ mode: "path", from: "Alpha", to: { x: 550, y: 150 }, level: "Cellar" }), ["L1", ["L1"]]);
  assert.deepEqual(run({ mode: "collision", from: "Near", to: "Alpha" }), ["L1", ["L1"]], "a token on a missing Level falls back to the initial Level");
  assert.throws(() => spatialQuery({ mode: "collision", from: "Alpha", to: "Near", level: "Attic" }), /level "Attic" is not a Level of scene "Test"/);
});
