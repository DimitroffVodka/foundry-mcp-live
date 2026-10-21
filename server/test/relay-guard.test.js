import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { RELAY_TOOLS, findStoredCode } from "../../module/lib/relay-guard.js";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// Keys of the `const handlers = { ... }` table in bridge.js (two-space indent),
// including shorthand entries like `stage,`.
function bridgeHandlerNames() {
  const src = read("module/scripts/bridge.js");
  const start = src.indexOf("const handlers = {");
  const end = src.indexOf("\n};", start);
  return new Set([...src.slice(start, end).matchAll(/^  ([a-z_]+)(?:: |,$)/gm)].map(m => m[1]));
}

// Every quoted lower_snake literal in the server's tools and lib: the bridge
// handler names server tools route to, as registerRoutedTool / action maps /
// requestFoundry calls spell them.
function serverLiterals() {
  const out = new Set();
  for (const dir of ["server/tools/", "server/lib/"]) {
    for (const f of readdirSync(new URL(dir, root)).filter(f => f.endsWith(".js"))) {
      for (const m of read(dir + f).matchAll(/["'`]([a-z_]+)["'`]/g)) out.add(m[1]);
    }
  }
  return out;
}

test("RELAY_TOOLS: every relay-reachable handler exists and is mapped by a server tool", () => {
  const handlers = bridgeHandlerNames();
  const used = serverLiterals();
  for (const name of RELAY_TOOLS) {
    assert.ok(handlers.has(name), `${name} is allow-listed but bridge.js has no such handler`);
    assert.ok(used.has(name), `${name} is allow-listed but no server tool routes to it`);
  }
});

test("RELAY_TOOLS: every handler a server tool routes to is reachable over the relay", () => {
  const used = serverLiterals();
  const missing = [...bridgeHandlerNames()].filter(n => used.has(n) && !RELAY_TOOLS.has(n));
  assert.deepEqual(missing, [], "add these to RELAY_TOOLS or the relay path breaks them");
});

test("RELAY_TOOLS: handlers no server tool maps to stay unreachable", () => {
  for (const dead of ["create_region", "update_region", "create_journal_entry", "create_folder"]) {
    assert.ok(!RELAY_TOOLS.has(dead), dead);
  }
});

test("findStoredCode: ordinary writes pass", () => {
  assert.deepEqual(findStoredCode({ actorId: "a", system: { attributes: { hp: { value: 3 } } } }), []);
  assert.deepEqual(findStoredCode({ name: "Cave", grid: { size: 100 }, fog: true }), []);
  // dnd5e-style item source is an object/string outside any behavior: not code
  assert.deepEqual(findStoredCode({ items: [{ name: "Sword", system: { source: "PHB" } }] }), []);
  assert.deepEqual(findStoredCode({ type: "chat", command: "hi" }), []);
  assert.deepEqual(findStoredCode(undefined), []);
});

test("findStoredCode: Region behaviors, typed and untyped", () => {
  const embedded = { regions: [{ name: "r", behaviors: [{ type: "executeScript", system: { source: "x()" } }] }] };
  assert.equal(findStoredCode(embedded).length >= 1, true);
  assert.match(findStoredCode({ type: "executeMacro", system: { uuid: "Macro.x" } })[0], /executeMacro/);
  // An update to an existing behavior carries no type — the gateway's known hole
  assert.equal(findStoredCode({ behaviors: [{ _id: "b1", system: { source: "x()" } }] }).length, 1);
  assert.equal(findStoredCode({ "behaviors.0.system.source": "x()" }).length, 1);
  assert.equal(findStoredCode({ documentName: "RegionBehavior", updates: [{ _id: "b", "system.source": "x()" }] }).length, 1);
  assert.equal(findStoredCode({ documentName: "RegionBehavior", updates: [{ _id: "b", "system.uuid": "Macro.y" }] }).length, 1);
  // Safe behavior types pass
  assert.deepEqual(findStoredCode({ behaviors: [{ type: "teleportToken", system: { destination: "R.x" } }] }), []);
});

test("findStoredCode: macros (typed, Item Macro, DAE, Effect Macro)", () => {
  assert.match(findStoredCode({ name: "m", type: "script", command: "game.x()" })[0], /script Macro/);
  assert.deepEqual(findStoredCode({ name: "m", type: "chat", command: "/roll 1d20" }), []);
  assert.equal(findStoredCode({ items: [{ flags: { itemacro: { macro: { command: "x()" } } } }] }).length, 1);
  assert.equal(findStoredCode({ "flags.effectmacro.onCreate.script": "x()" }).length, 1);
});

test("findStoredCode: Monk's Active Tiles, Mass Edit, Item Piles", () => {
  const mat = { flags: { "monks-active-tiles": { active: true, actions: [{ action: "runcode", data: { code: "x()" } }] } } };
  assert.equal(findStoredCode(mat).length, 1);
  // MAT evals value fields too, so even an "alter" action is refused
  assert.equal(findStoredCode({ "flags.monks-active-tiles.actions": [{ action: "alter", data: { value: "= 1" } }] }).length, 1);
  assert.equal(findStoredCode({ "flags.monks-active-tiles.actions.0.data.code": "x()" }).length, 1);
  assert.deepEqual(findStoredCode({ flags: { "monks-active-tiles": { active: false } } }), []);
  assert.equal(findStoredCode({ preset: { postSpawnScript: "x()" } }).length, 1);
  assert.equal(findStoredCode({ "flags.item-piles.data.macro": "Macro.abc" }).length, 1);
  assert.deepEqual(findStoredCode({ "flags.item-piles.data.macro": "" }), []);
});

test("findStoredCode: reaches inside call_module_api args and refuses what it cannot read", () => {
  const params = { moduleId: "x", fn: "create", args: ["Scene.a", [{ type: "executeScript", system: { source: "x()" } }]] };
  assert.equal(findStoredCode(params).length, 1);
  let deep = {};
  const top = deep;
  for (let i = 0; i < 100; i++) deep = deep.a = {};
  assert.match(findStoredCode(top)[0], /too deep/);
});
