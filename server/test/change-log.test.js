import test from "node:test";
import assert from "node:assert/strict";

import { createChangeLog, restoreUpdate, undo, describeEntry } from "../../module/lib/change-log.js";

const clone = (v) => structuredClone(v);

// A tiny world: uuid -> source. apply() understands Foundry's flattened update
// keys and `-=` removals, which is all restoreUpdate emits.
function fakeWorld(docs = {}) {
  const world = new Map(Object.entries(clone(docs)));
  let clock = 1000;
  const applied = [];
  const env = {
    callId: "undo-1",
    current: async (uuid) => (world.has(uuid) ? clone(world.get(uuid)) : null),
    permission: async () => null,
    apply: async (step) => {
      applied.push(step.op);
      if (step.op === "delete") return void world.delete(step.uuid);
      if (step.op === "create") return void world.set(step.uuid, { ...clone(step.data), _stats: { modifiedTime: ++clock } });
      const doc = world.get(step.uuid);
      for (const [k, v] of Object.entries(step.update)) {
        const parts = k.split(".");
        const last = parts.pop();
        let o = doc;
        for (const p of parts) o = o[p] ??= {};
        if (last.startsWith("-=")) delete o[last.slice(2)];
        else o[last] = clone(v);
      }
      doc._stats = { modifiedTime: ++clock };
    },
  };
  return { world, env, applied };
}

const actor = (hp, extra = {}) => ({ _id: "a1", name: "Bob", system: { hp }, items: [], _stats: { modifiedTime: hp }, ...extra });

function logWith(...changes) {
  const log = createChangeLog({ now: () => "t" });
  for (const c of changes) {
    log.begin(c.callId, c.tool ?? "update_actor");
    log.record({ documentName: "Actor", uuid: "Actor.a1", name: "Bob", embedded: ["items"], tool: "update_actor", ...c });
    log.end(c.callId);
  }
  return log;
}

test("restoreUpdate: old values back, added keys removed with -=, embedded and _stats left alone", () => {
  const before = { name: "A", system: { hp: 5, tags: ["x"] }, flags: {}, items: [1], _stats: { m: 1 } };
  const now = { name: "B", system: { hp: 5, tags: ["x", "y"], temp: 3 }, flags: { mod: { a: 1 } }, items: [2], _stats: { m: 2 } };
  assert.deepEqual(restoreUpdate(before, now, ["_stats", "items"]), {
    name: "A", "system.tags": ["x"], "system.-=temp": null, "flags.-=mod": null,
  });
  // a key whose value turned from a scalar into an object is set back wholesale
  assert.deepEqual(restoreUpdate({ a: 5 }, { a: { b: 1 } }), { a: 5 });
  assert.deepEqual(restoreUpdate({ a: { b: 1 } }, { a: { b: 1 } }), {});
});

test("record: oversize snapshots are dropped and the entry marked not undoable", () => {
  const log = createChangeLog({ maxChars: 50 });
  log.begin("k1", "update_actor");
  const e = log.record({ callId: "k1", tool: "update_actor", action: "update", documentName: "Actor",
    uuid: "Actor.a1", before: { big: "x".repeat(60) }, after: { big: "y" } });
  assert.equal(e.undoable, false);
  assert.equal(e.before, null);
  assert.match(e.reason, /50-character snapshot cap/);
});

test("record: update snapshots leave out embedded collections; delete snapshots keep them", () => {
  const log = createChangeLog();
  const u = log.record({ callId: "k", action: "update", documentName: "Scene", uuid: "Scene.s", embedded: ["walls"],
    before: { name: "A", walls: [1] }, after: { name: "B", walls: [1] } });
  assert.deepEqual([u.before, u.after], [{ name: "A" }, { name: "B" }]);
  const d = log.record({ callId: "k", action: "delete", documentName: "Scene", uuid: "Scene.s", embedded: ["walls"],
    before: { name: "B", walls: [1] } });
  assert.deepEqual(d.before.walls, [1]);
});

test("record: ring keeps the newest entries; chat and overlapping calls are not undoable", () => {
  const log = createChangeLog({ limit: 3 });
  log.begin("k1", "send_chat_message");
  for (let i = 0; i < 5; i++) log.record({ callId: "k1", action: "create", documentName: "ChatMessage", uuid: `ChatMessage.m${i}`, after: {} });
  assert.deepEqual(log.entries.map(e => e.id), ["c3", "c4", "c5"]);
  assert.match(log.entries[0].reason, /chat messages/);
  log.begin("k2", "update_actor");
  assert.deepEqual(log.attribute(), { callId: "k2", tool: "update_actor", ambiguous: true });
  const e = log.record({ ...log.attribute(), action: "update", documentName: "Actor", uuid: "Actor.a1", before: {}, after: {} });
  assert.match(e.reason, /another call was running/);
  const lost = log.record({ callId: "k2", action: "update", documentName: "Actor", uuid: "Actor.a1", before: null, after: {} });
  assert.match(lost.reason, /before the change was not captured/);
  assert.equal(describeEntry(e).before, undefined);
});

test("undo an update restores field by field, reads back, and the undo can be undone (redo)", async () => {
  const { world, env } = fakeWorld({ "Actor.a1": actor(3, { system: { hp: 3, temp: 9 } }) });
  const log = logWith({ callId: "k1", action: "update", before: actor(5), after: world.get("Actor.a1") });
  const res = await undo(log, log.select({}), env);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.applied[0].readBack, { ok: true });
  assert.deepEqual(world.get("Actor.a1").system, { hp: 5 });
  assert.equal(log.entries[0].undoneBy, "undo-1");

  // the undo's own change is logged like any other; undoing it redoes
  log.begin("undo-1", "changes_undo");
  log.record({ callId: "undo-1", tool: "changes_undo", action: "update", documentName: "Actor", uuid: "Actor.a1",
    embedded: ["items"], before: actor(3, { system: { hp: 3, temp: 9 } }), after: clone(world.get("Actor.a1")) });
  log.end("undo-1");
  const redo = await undo(log, log.select({}), { ...env, callId: "undo-2" });
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.deepEqual(world.get("Actor.a1").system, { hp: 3, temp: 9 });
});

test("undo deletes what a call created and recreates what it deleted, newest first", async () => {
  const { world, env, applied } = fakeWorld({ "Actor.n1": { _id: "n1", name: "New", _stats: { modifiedTime: 7 } } });
  const log = createChangeLog();
  log.begin("k1", "create_actor");
  log.record({ callId: "k1", tool: "delete_actor", action: "delete", documentName: "Actor", uuid: "Actor.o1",
    before: { _id: "o1", name: "Old", items: [{ _id: "i1" }] } });
  log.record({ callId: "k1", tool: "create_actor", action: "create", documentName: "Actor", uuid: "Actor.n1",
    after: { _id: "n1", name: "New", _stats: { modifiedTime: 7 } } });
  const res = await undo(log, log.select({ callId: "k1" }), env);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(applied, ["delete", "create"]);
  assert.equal(world.has("Actor.n1"), false);
  assert.deepEqual(world.get("Actor.o1").items, [{ _id: "i1" }]);
});

test("drift refuses the whole undo and writes nothing", async () => {
  const cases = {
    "later entry": async () => {
      const { env } = fakeWorld({ "Actor.a1": actor(1) });
      const log = logWith(
        { callId: "k1", action: "update", before: actor(5), after: actor(3) },
        { callId: "k2", action: "update", before: actor(3), after: actor(1) });
      return [await undo(log, log.select({ callId: "k1" }), env), /changed again afterwards by c2/];
    },
    "modifiedTime": async () => {
      const { env } = fakeWorld({ "Actor.a1": { ...actor(3), _stats: { modifiedTime: 99 } } });
      const log = logWith({ callId: "k1", action: "update", before: actor(5), after: actor(3) });
      return [await undo(log, log.select({}), env), /after the recorded change/];
    },
    "state": async () => {
      const { env } = fakeWorld({ "Actor.a1": { ...actor(3), name: "Renamed" } });
      const log = logWith({ callId: "k1", action: "update", before: actor(5), after: actor(3) });
      return [await undo(log, log.select({}), env), /differs from the recorded state at name/];
    },
    "gone": async () => {
      const { env } = fakeWorld({});
      const log = logWith({ callId: "k1", action: "update", before: actor(5), after: actor(3) });
      return [await undo(log, log.select({}), env), /no longer exists/];
    },
    "permission": async () => {
      const { env } = fakeWorld({ "Actor.a1": actor(3) });
      const log = logWith({ callId: "k1", action: "update", before: actor(5), after: actor(3) });
      return [await undo(log, log.select({}), { ...env, permission: async () => "Player may not update" }), /Player may not update/];
    },
    "env gate": async () => {
      const { env } = fakeWorld({ "Actor.a1": actor(3) });
      const log = logWith({ callId: "k1", action: "update", before: actor(5), after: actor(3) });
      return [await undo(log, log.select({}), { ...env, refuseTools: ["update_actor"] }), /FOUNDRY_MCP_ALLOW_WRITE/];
    },
    "not undoable": async () => {
      const { env } = fakeWorld({});
      const log = createChangeLog();
      log.begin("k1", "send_chat_message");
      log.record({ callId: "k1", tool: "send_chat_message", action: "create", documentName: "ChatMessage", uuid: "ChatMessage.m", after: {} });
      return [await undo(log, log.select({}), env), /chat messages/];
    },
  };
  for (const [name, run] of Object.entries(cases)) {
    const [res, why] = await run();
    assert.equal(res.ok, false, name);
    assert.ok(res.problems.some(p => why.test(p)), `${name}: ${JSON.stringify(res.problems)}`);
  }
  // one bad step blocks the good ones in the same call
  const { world, env, applied } = fakeWorld({ "Actor.a1": actor(3), "Actor.b1": { _id: "b1", name: "Moved" } });
  const log = logWith(
    { callId: "k1", action: "update", before: actor(5), after: actor(3) },
    { callId: "k1", action: "update", uuid: "Actor.b1", before: { _id: "b1", name: "B" }, after: { _id: "b1", name: "C" } });
  const res = await undo(log, log.select({}), env);
  assert.equal(res.ok, false);
  assert.deepEqual(applied, []);
  assert.equal(world.get("Actor.a1").system.hp, 3);
});

test("undo by entry id takes only that entry; an empty log says so", async () => {
  const log = logWith(
    { callId: "k1", action: "update", before: actor(5), after: actor(3) },
    { callId: "k1", action: "update", uuid: "Actor.b1", before: { _id: "b1", n: 1 }, after: { _id: "b1", n: 2 } });
  assert.deepEqual(log.select({ entryId: "c2" }).map(e => e.id), ["c2"]);
  const { env } = fakeWorld({});
  assert.deepEqual((await undo(createChangeLog(), [], env)).problems, ["nothing in the change log matches"]);
});
