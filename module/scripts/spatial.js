/**
 * Read-only spatial queries behind query_grid's `mode` (path, collision,
 * range, measure), and the A* grid pathfinder `move_token_pathed` also uses.
 *
 * Every wall rule comes from Foundry itself: collisions are the polygon
 * backends' testCollision (CONFIG.Canvas.polygonBackends), distances are
 * scene.grid.measurePath (which applies the core diagonal rule). Nothing here
 * re-implements wall semantics, so door states, limited walls and
 * directional walls stay whatever core says they are.
 */

export const DEFAULT_MAX_NODES = 2500;
export const MAX_NODES_LIMIT = 10_000;
const SENSES = ["move", "sight", "light", "sound"];

// Test whether a multi-cell token can move between two pixel corners without
// any occupied subcell colliding. Origin/target are top-left pixel coords.
export function cellsBlocked(fx, fy, tx, ty, tokenW, tokenH, gridSize, collision, level) {
  for (let i = 0; i < tokenW; i++) {
    for (let j = 0; j < tokenH; j++) {
      const ox = fx + i * gridSize + gridSize / 2;
      const oy = fy + j * gridSize + gridSize / 2;
      const dx = tx + i * gridSize + gridSize / 2;
      const dy = ty + j * gridSize + gridSize / 2;
      if (collision.testCollision({ x: ox, y: oy }, { x: dx, y: dy }, { type: "move", mode: "any", level })) return true;
    }
  }
  return false;
}

// A* over square-grid cells (8-way, every step costs 1). Returns
// { path: [{x,y} top-left px], cost }, null when no route exists, or
// { path: [], cost: 0, capped: true } when maxNodes ran out first.
// ponytail: square-grid stepping only; hex scenes get square-cell paths. Use the grid's own adjacency if hex paths are needed.
export function findGridPath({ startX, startY, endX, endY, gridSize, collision, tokenWidth = 1, tokenHeight = 1, maxNodes = DEFAULT_MAX_NODES, level }) {
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  const key  = (gx, gy) => `${gx},${gy}`;

  const sGX = Math.floor(startX / gridSize);
  const sGY = Math.floor(startY / gridSize);
  const eGX = Math.floor(endX   / gridSize);
  const eGY = Math.floor(endY   / gridSize);
  if (sGX === eGX && sGY === eGY) return { path: [], cost: 0 };

  const open     = [{ gx: sGX, gy: sGY, g: 0, f: cheb(sGX, sGY, eGX, eGY) }];
  const gScore   = new Map([[key(sGX, sGY), 0]]);
  const cameFrom = new Map();
  const closed   = new Set();
  let explored   = 0;

  while (open.length > 0) {
    if (explored >= maxNodes) return { path: [], cost: 0, capped: true };
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[minIdx].f) minIdx = i;
    const cur = open[minIdx];

    if (cur.gx === eGX && cur.gy === eGY) {
      const path = [];
      let k = key(eGX, eGY);
      while (cameFrom.has(k)) {
        const [gxs, gys] = k.split(",");
        path.push({ x: Number(gxs) * gridSize, y: Number(gys) * gridSize });
        k = cameFrom.get(k);
      }
      path.reverse();
      return { path, cost: cur.g };
    }

    open.splice(minIdx, 1);
    const curKey = key(cur.gx, cur.gy);
    closed.add(curKey);
    explored++;

    for (const [dx, dy] of DIRS) {
      const nx = cur.gx + dx;
      const ny = cur.gy + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (cellsBlocked(cur.gx * gridSize, cur.gy * gridSize, nx * gridSize, ny * gridSize, tokenWidth, tokenHeight, gridSize, collision, level)) continue;
      const tg = cur.g + 1;
      const existing = gScore.get(nk);
      if (existing !== undefined && tg >= existing) continue;
      cameFrom.set(nk, curKey);
      gScore.set(nk, tg);
      const f = tg + cheb(nx, ny, eGX, eGY);
      const eIdx = open.findIndex(n => n.gx === nx && n.gy === ny);
      if (eIdx >= 0) { open[eIdx].g = tg; open[eIdx].f = f; }
      else open.push({ gx: nx, gy: ny, g: tg, f });
    }
  }
  return null;
}

// Resolve a token reference (id, token name, or linked actor name).
function findToken(scene, ref) {
  return scene.tokens.get(ref)
      ?? scene.tokens.find(t => t.name === ref)
      ?? scene.tokens.find(t => t.actor?.name === ref);
}

// `from`/`to` are a token reference (string) or a pixel point {x, y}.
function resolvePoint(scene, ref, label) {
  if (typeof ref === "string") {
    const token = findToken(scene, ref);
    if (!token) throw new Error(`${label}: token not found: ${ref}`);
    return { token, point: token.getCenterPoint() };
  }
  if (ref && Number.isFinite(ref.x) && Number.isFinite(ref.y)) return { token: null, point: { x: ref.x, y: ref.y } };
  throw new Error(`${label} must be a token id/name or a pixel point {x, y}`);
}

// Walls are only built for the scene this client has drawn.
function wallScene() {
  const scene = canvas?.ready ? canvas.scene : null;
  if (!scene) throw new Error("This mode tests walls, which Foundry only loads for the scene on this client's canvas, and no scene is drawn. View the scene first.");
  return scene;
}

// v14 tests walls per Level (polygon config.level, which core defaults to canvas.level); v13 has no Levels.
export function wallLevel(scene, ref, token) {
  if (ref !== undefined) {
    const level = scene.levels?.get(ref) ?? scene.levels?.getName?.(ref);
    if (!level) throw new Error(`level "${ref}" is not a Level of scene "${scene.name}"`);
    return level;
  }
  if (token && scene.levels) return scene.levels.get(token._source.level) ?? scene.initialLevel;
  return canvas.level;
}

function measure(scene, points) {
  const r = scene.grid.measurePath(points);
  return { distance: r.distance, cost: r.cost, spaces: r.spaces, diagonals: r.diagonals, euclidean: r.euclidean };
}

// The walls (and first contact point) between two points, per restriction type.
function collisionsBetween(a, b, types, level) {
  const out = {};
  for (const type of types) {
    const hits = CONFIG.Canvas.polygonBackends[type].testCollision(a, b, { type, mode: "all", level });
    const walls = new Set();
    for (const v of hits) for (const e of v.edges ?? []) if (e.type === "wall") walls.add(e.object?.id ?? e.id.replace(/^wall\./, ""));
    out[type] = { blocked: hits.length > 0, walls: [...walls] };
    if (hits[0]) out[type].at = { x: Math.round(hits[0].x), y: Math.round(hits[0].y) };
  }
  return out;
}

const MODES = {
  path(p) {
    const scene = wallScene();
    const size = scene.grid.size;
    const from = resolvePoint(scene, p.from, "from");
    const to = resolvePoint(scene, p.to, "to");
    const level = wallLevel(scene, p.level, from.token);
    const lv = level?.id ?? null;
    const maxNodes = p.maxNodes ?? DEFAULT_MAX_NODES;
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_NODES_LIMIT) {
      throw new Error(`maxNodes must be an integer 1-${MAX_NODES_LIMIT}`);
    }
    // A* works in top-left cell corners, as the token move does.
    const start = from.token ?? { x: from.point.x, y: from.point.y, width: 1, height: 1 };
    const result = findGridPath({
      startX: start.x, startY: start.y, endX: to.point.x, endY: to.point.y, gridSize: size,
      collision: CONFIG.Canvas.polygonBackends.move,
      tokenWidth: start.width, tokenHeight: start.height, maxNodes, level,
    });
    if (!result) return { mode: "path", level: lv, reachable: false, reason: "No route: walls (or closed doors) cut the destination off." };
    if (result.capped) {
      return { mode: "path", level: lv, reachable: false, reason: `Gave up after ${maxNodes} cells (maxNodes). Raise maxNodes or ask for a shorter leg.` };
    }
    const half = size / 2;
    const waypoints = result.path.map(c => ({ x: c.x, y: c.y, gx: c.x / size, gy: c.y / size }));
    const centers = [{ x: Math.floor(start.x / size) * size + half, y: Math.floor(start.y / size) * size + half },
      ...waypoints.map(w => ({ x: w.x + half, y: w.y + half }))];
    return { mode: "path", level: lv, reachable: true, steps: result.cost, waypoints, ...measure(scene, centers), units: scene.grid.units };
  },

  collision(p) {
    const scene = wallScene();
    const from = resolvePoint(scene, p.from, "from");
    const a = from.point;
    const level = wallLevel(scene, p.level, from.token);
    const b = resolvePoint(scene, p.to, "to").point;
    const types = p.types?.length ? p.types : SENSES;
    const bad = types.filter(t => !SENSES.includes(t));
    if (bad.length) throw new Error(`Unknown collision type(s) ${bad.join(", ")}; use ${SENSES.join("|")}`);
    return { mode: "collision", from: a, to: b, level: level?.id ?? null, ...collisionsBetween(a, b, types, level) };
  },

  range(p) {
    const scene = wallScene();
    if (!Number.isFinite(p.distance) || p.distance < 0) throw new Error("range needs distance (scene units, e.g. feet)");
    const from = resolvePoint(scene, p.from, "from");
    const level = wallLevel(scene, p.level, from.token);
    const tokens = [];
    for (const t of scene.tokens) {
      if (t === from.token) continue;
      const c = t.getCenterPoint();
      const { distance } = measure(scene, [from.point, c]);
      if (distance > p.distance) continue;
      if (p.lineOfSight && CONFIG.Canvas.polygonBackends.sight.testCollision(from.point, c, { type: "sight", mode: "any", level })) continue;
      tokens.push({ id: t.id, name: t.name, actorId: t.actorId, x: c.x, y: c.y, distance });
    }
    tokens.sort((x, y) => x.distance - y.distance);
    return { mode: "range", from: from.point, level: level?.id ?? null, distance: p.distance, units: scene.grid.units, lineOfSight: !!p.lineOfSight, count: tokens.length, tokens };
  },

  measure(p) {
    const scene = p.sceneId ? game.scenes.get(p.sceneId) : (canvas?.scene ?? game.scenes.active);
    if (!scene) throw new Error(p.sceneId ? `Scene not found: ${p.sceneId}` : "No scene to measure on; pass sceneId");
    let points = p.waypoints;
    if (!points) points = [resolvePoint(scene, p.from, "from").point, resolvePoint(scene, p.to, "to").point];
    if (!Array.isArray(points) || points.length < 2 || !points.every(q => Number.isFinite(q?.x) && Number.isFinite(q?.y))) {
      throw new Error("measure needs from+to, or waypoints: at least two {x, y} pixel points");
    }
    const rule = Object.entries(CONST.GRID_DIAGONALS).find(([, v]) => v === scene.grid.diagonals)?.[0]?.toLowerCase();
    return { mode: "measure", sceneId: scene.id, ...measure(scene, points), units: scene.grid.units, diagonalRule: rule ?? null };
  },
};

export function spatialQuery(params = {}) {
  const run = MODES[params.mode];
  if (!run) throw new Error(`Unknown query_grid mode "${params.mode}"; use cells|${Object.keys(MODES).join("|")}`);
  return run(params);
}
