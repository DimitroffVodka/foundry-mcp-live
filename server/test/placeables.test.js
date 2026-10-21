import test from "node:test";
import assert from "node:assert/strict";

import { mapWallWords, placeable, storedDifferently, wordValue } from "../../module/scripts/placeables.js";
import { findStoredCode, relayRefusal } from "../../module/lib/relay-guard.js";

const CONST = {
  WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
  WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  WALL_SENSE_TYPES: { NONE: 0, LIMITED: 10, NORMAL: 20, PROXIMITY: 30, DISTANCE: 40 },
  WALL_DIRECTIONS: { BOTH: 0, LEFT: 1, RIGHT: 2 },
};

test("wall words map to CONST values; numbers pass through; unknown words list the choices", () => {
  assert.deepEqual(
    mapWallWords({ c: [0, 0, 1, 1], door: "Secret", ds: "locked", move: "none", sight: "limited", light: 20, dir: "left" }, CONST),
    { c: [0, 0, 1, 1], door: 2, ds: 2, move: 0, sight: 10, light: 20, dir: 1 });
  assert.throws(() => wordValue(CONST, "WALL_DOOR_TYPES", "door", "trapdoor"), /door "trapdoor" is not one of none\|door\|secret/);
});

test("storedDifferently reports only sent fields whose stored value differs", () => {
  const sent = { x: 310.6, config: { dim: 30 }, c: [200.4, 1, 2, 3], shapes: [{ type: "rectangle" }] };
  const stored = { x: 311, y: 0, config: { dim: 30, bright: 0 }, c: [200, 1, 2, 3], shapes: [{ type: "rectangle", hole: false }] };
  assert.deepEqual(storedDifferently(sent, stored), [
    { field: "x", sent: 310.6, stored: 311 },
    { field: "c.0", sent: 200.4, stored: 200 },
  ]);
  assert.deepEqual(storedDifferently({ c: [1, 2] }, { c: [1, 2, 3, 4] }), [{ field: "c", sent: [1, 2], stored: [1, 2, 3, 4] }]);
});

// A scene with one embedded collection per type, recording every write.
function fakeWorld({ allowMutations = true } = {}) {
  const writes = [];
  const collections = {};
  const coll = (type) => (collections[type] ??= new Map());
  // Walls are stored with rounded coordinates, as core's integer field does.
  const asDoc = (data) => {
    const stored = structuredClone({ ...data, ...(data.c && { c: data.c.map(Math.round) }) });
    return { ...stored, id: data._id, toObject: () => structuredClone(stored),
      clone: () => ({ updateSource: (c) => { if (c.c && c.c.length !== 4) throw new Error("c: must be a length-4 array"); } }) };
  };
  const scene = {
    id: "s1", name: "Test",
    getEmbeddedCollection: (type) => {
      const m = coll(type);
      return { get: (id) => m.get(id), has: (id) => m.has(id), filter: (fn) => [...m.values()].filter(fn) };
    },
    async createEmbeddedDocuments(type, data, opts) {
      writes.push({ op: "create", type, data, opts });
      // Reverse on purpose: Foundry does not promise input order.
      return data.map((d) => { coll(type).set(d._id, asDoc(d)); return coll(type).get(d._id); }).reverse();
    },
    async updateEmbeddedDocuments(type, updates) {
      writes.push({ op: "update", type, updates });
      for (const u of updates) coll(type).set(u._id, asDoc({ ...coll(type).get(u._id).toObject(), ...u }));
    },
    async deleteEmbeddedDocuments(type, ids) {
      writes.push({ op: "delete", type, ids });
      for (const id of ids) coll(type).delete(id);
    },
  };
  Object.defineProperty(scene, "walls", { get: () => scene.getEmbeddedCollection("Wall") });

  // Stand-in for Foundry's data model: walls need four coordinates; core cleans its argument in place.
  class WallDocument {
    constructor(data) {
      if (!Array.isArray(data.c) || data.c.length !== 4) throw new Error("c: must be a length-4 array");
      data.c = data.c.map(Math.round);
    }
  }
  let n = 0;
  let calls = 0;
  globalThis.CONST = CONST;
  globalThis.CONFIG = { Wall: { documentClass: WallDocument }, AmbientLight: { documentClass: class {} } };
  globalThis.foundry = { utils: {
    deepClone: (v) => structuredClone(v),
    expandObject: (v) => structuredClone(v),
    mergeObject: (a, b) => ({ ...a, ...b, flags: { ...a.flags, ...b.flags } }),
    randomID: (len) => (len ? `c${++calls}` : `id${++n}`), // call ids ask for a length, document ids do not
  } };
  globalThis.game = {
    scenes: { get: (id) => (id === "s1" ? scene : undefined), active: scene },
    settings: { get: () => allowMutations },
  };
  return { scene, writes, coll, asDoc };
}

test("create: one bad entry writes nothing and names every bad entry", async () => {
  const { writes } = fakeWorld();
  await assert.rejects(
    placeable({ action: "create", type: "Wall", entries: [{ c: [0, 0, 1, 1] }, { c: [1] }, { c: [0, 0, 1, 1], door: "gate" }] }),
    /Nothing written: 2 of 3 entries are invalid — \[1\] c: must be.*\[2\] door "gate"/);
  assert.equal(writes.length, 0);
});

test("create: flags each document, keeps ids aligned to entries, reports what Foundry stored differently", async () => {
  const { writes } = fakeWorld();
  const r = await placeable({ action: "create", type: "Wall", entries: [{ c: [0, 0, 100, 0] }, { c: [200.4, 0, 200.4, 100], door: "door" }] });
  assert.deepEqual(r.ids, ["id1", "id2"], "ids follow entry order even though the create returned them reversed");
  assert.equal(writes[0].opts.keepId, true);
  assert.deepEqual(writes[0].data.map((d) => d.flags["foundry-mcp-live"].createdBy), ["placeable", "placeable"]);
  assert.match(r.callId, /^placeable-/);
  assert.deepEqual(writes[0].data.map((d) => d.flags["foundry-mcp-live"].callId), [r.callId, r.callId]);
  assert.equal(writes[0].data[1].door, 1, "plain word mapped before writing");
  assert.deepEqual(r.storedDifferently, [
    { index: 1, id: "id2", field: "c.0", sent: 200.4, stored: 200 },
    { index: 1, id: "id2", field: "c.2", sent: 200.4, stored: 200 },
  ]);
});

test("create: a multi-level scene needs level or levels; level names resolve; the dispatcher's callId is used", async () => {
  const { scene, writes } = fakeWorld();
  const levels = [{ id: "L1", name: "Cellar" }, { id: "L2", name: "Ground" }];
  scene.levels = Object.assign(levels, { size: 2, get: (id) => levels.find((l) => l.id === id), getName: (n) => levels.find((l) => l.name === n) });
  await assert.rejects(placeable({ action: "create", type: "Wall", entries: [{ c: [0, 0, 1, 1] }] }),
    /\[0\] scene has Levels \(Cellar, Ground\): pass level/);
  await assert.rejects(placeable({ action: "create", type: "Wall", level: "Attic", entries: [{ c: [0, 0, 1, 1] }] }), /level "Attic" is not a Level/);
  assert.equal(writes.length, 0);
  const r = await placeable({ action: "create", type: "Wall", level: "Ground", entries: [{ c: [0, 0, 1, 1] }, { c: [0, 0, 2, 2], levels: [] }] },
    { callId: "gm-abc" });
  assert.deepEqual(writes[0].data.map((d) => d.levels), [["L2"], []]);
  assert.equal(r.callId, "gm-abc");
});

test("create: type, size and read-only gates", async () => {
  fakeWorld();
  await assert.rejects(placeable({ action: "create", type: "Token", entries: [{}] }), /type must be one of/);
  await assert.rejects(placeable({ action: "create", type: "Wall", entries: Array(201).fill({ c: [0, 0, 1, 1] }) }), /at most 200/);
  await assert.rejects(placeable({ action: "create", type: "Wall", entries: [] }), /non-empty entries/);
  const { writes } = fakeWorld({ allowMutations: false });
  await assert.rejects(placeable({ action: "create", type: "Wall", entries: [{ c: [0, 0, 1, 1] }] }), /World mutations are disabled/);
  assert.equal(writes.length, 0);
});

test("update: a missing _id or invalid change writes nothing; changes are read back", async () => {
  const { writes, coll, asDoc } = fakeWorld();
  coll("Wall").set("w1", asDoc({ _id: "w1", c: [0, 0, 1, 1], sight: 20 }));
  await assert.rejects(placeable({ action: "update", type: "Wall", entries: [{ _id: "w1", sight: "none" }, { _id: "nope" }] }),
    /1 of 2 entries are invalid — \[1\] no Wall with _id "nope"/);
  await assert.rejects(placeable({ action: "update", type: "Wall", entries: [{ _id: "w1", c: [1] }] }), /c: must be/);
  assert.equal(writes.length, 0);
  const r = await placeable({ action: "update", type: "Wall", entries: [{ _id: "w1", sight: "limited", c: [0, 0, 9.6, 1] }] });
  assert.deepEqual(writes[0].updates, [{ _id: "w1", sight: 10, c: [0, 0, 9.6, 1] }]);
  assert.deepEqual(r.storedDifferently, [{ index: 0, id: "w1", field: "c.2", sent: 9.6, stored: 10 }]);
});

test("delete: dryRun lists and deletes nothing; createdByMcp selects only flagged documents", async () => {
  const { writes, coll, asDoc } = fakeWorld();
  await placeable({ action: "create", type: "Wall", entries: [{ c: [0, 0, 1, 1] }] });
  coll("Wall").set("mine", asDoc({ _id: "mine", c: [5, 5, 6, 6], flags: {} }));
  const dry = await placeable({ action: "delete", type: "Wall", createdByMcp: true, dryRun: true });
  assert.deepEqual(dry.documents, [{ id: "id1", label: "0,0,1,1" }]);
  assert.equal(writes.filter((w) => w.op === "delete").length, 0);
  const second = await placeable({ action: "create", type: "Wall", entries: [{ c: [2, 2, 3, 3] }] });
  const one = await placeable({ action: "delete", type: "Wall", callId: second.callId, dryRun: true });
  assert.deepEqual(one.documents.map((d) => d.id), second.ids, "callId selects only that call's documents");
  await placeable({ action: "delete", type: "Wall", createdByMcp: true });
  assert.deepEqual([...coll("Wall").keys()], ["mine"]);
  await assert.rejects(placeable({ action: "delete", type: "Wall", ids: ["mine", "ghost"] }), /Nothing deleted: no Wall with id ghost/);
  assert.ok(coll("Wall").has("mine"));
});

test("door: sets ds from a word, refuses non-door walls before writing", async () => {
  const { writes, coll, asDoc } = fakeWorld();
  coll("Wall").set("d1", asDoc({ _id: "d1", door: 1, ds: 0 }));
  coll("Wall").set("w1", asDoc({ _id: "w1", door: 0, ds: 0 }));
  await assert.rejects(placeable({ action: "door", ids: ["d1", "w1"], state: "open" }), /w1: not a door/);
  assert.equal(writes.length, 0);
  const r = await placeable({ action: "door", ids: ["d1"], state: "locked" });
  assert.equal(r.ds, 2);
  assert.deepEqual(writes[0].updates, [{ _id: "d1", ds: 2 }]);
});

test("relay: Region code behaviors in placeable params are stored code", () => {
  const create = { action: "create", type: "Region", entries: [{ name: "Trap", shapes: [],
    behaviors: [{ type: "executeScript", system: { source: "game.togglePause()" } }] }] };
  assert.ok(findStoredCode(create).length > 0);
  assert.match(relayRefusal("placeable", create, false), /would store code/);
  assert.equal(relayRefusal("placeable", create, true), null);
  const update = { action: "update", type: "Region", entries: [{ _id: "r1", behaviors: [{ _id: "b1", system: { source: "x()" } }] }] };
  assert.ok(findStoredCode(update).length > 0);
  assert.equal(relayRefusal("placeable", { action: "create", type: "Wall", entries: [{ c: [0, 0, 1, 1] }] }, false), null);
});
