import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HANDLER_ACCESS, accessRefusal } from "../../module/lib/handler-access.js";

const src = readFileSync(new URL("../../module/scripts/bridge.js", import.meta.url), "utf8");

// Keys of the `const handlers = { ... }` table (two-space indent, shorthand like `stage,` too).
function bridgeHandlerNames() {
  const start = src.indexOf("const handlers = {");
  const end = src.indexOf("\n};", start);
  return [...src.slice(start, end).matchAll(/^  ([a-z_]+)(?:: |,$)/gm)].map(m => m[1]);
}

test("every bridge handler declares read, write or delete access", () => {
  const names = bridgeHandlerNames();
  assert.ok(names.length > 90, `parsed only ${names.length} handlers`);
  const undeclared = names.filter(n => !["read", "write", "delete"].includes(HANDLER_ACCESS[n]));
  assert.deepEqual(undeclared, [], "declare these in module/lib/handler-access.js");
  const stale = Object.keys(HANDLER_ACCESS).filter(n => !names.includes(n));
  assert.deepEqual(stale, [], "HANDLER_ACCESS names handlers bridge.js no longer has");
});

test("handlers that wrap runAuditedMutation are not declared read", () => {
  const start = src.indexOf("const handlers = {");
  const body = src.slice(start, src.indexOf("\n};", start));
  const wrapped = [...body.matchAll(/runAuditedMutation\("([a-z_]+)"/g)].map(m => m[1]);
  assert.ok(wrapped.length > 40);
  assert.deepEqual(wrapped.filter(n => HANDLER_ACCESS[n] === "read"), []);
});

test("dispatch checks accessRefusal before any handler runs, on both paths", () => {
  const start = src.indexOf("async function dispatch(tool, params)");
  assert.ok(start >= 0, "dispatch() not found in bridge.js");
  const body = src.slice(start, src.indexOf("\n}", start));
  const check = body.indexOf("const refused = accessRefusal(tool, ");
  const thrown = body.indexOf("if (refused) throw new Error(refused);");
  const call = body.indexOf("handlers[tool](");
  assert.ok(check >= 0 && thrown > check && call > thrown, body);
  // the only other handlers[tool]( call sites are inside dispatch()
  const calls = [...src.matchAll(/handlers\[tool\]\(/g)].map(m => m.index);
  assert.ok(calls.every(i => i > start && i < start + body.length), "a handler is called outside dispatch()");
  assert.match(src, /const data = await dispatch\(tool, params\);/);
});

test("accessRefusal: reads always run, unknown tools never do", () => {
  const boom = () => { throw new Error("not registered"); };
  assert.equal(accessRefusal("get_actor", boom), null);
  assert.equal(accessRefusal("get_actor", () => false), null);
  assert.match(accessRefusal("nope", () => true), /Unknown tool: nope/);
});

test("accessRefusal: writes need the setting to be exactly true and name it when refused", () => {
  assert.equal(accessRefusal("update_actor", () => true), null);
  assert.equal(accessRefusal("delete_actor", () => true), null);
  for (const [read, why] of [
    [() => false, /is off/],
    [() => { throw new Error("not registered"); }, /could not be read \(not registered\)/],
    [() => "yes", /holds "yes"/],
    [() => undefined, /holds undefined/],
    [() => null, /holds null/],
  ]) {
    const msg = accessRefusal("update_actor", read);
    assert.match(msg, why);
    assert.match(msg, /"Allow AI to modify the world" \(foundry-mcp-live\.allowWorldMutations\)/);
    assert.match(accessRefusal("delete_actor", read), /"delete_actor" was refused/);
  }
});

test("the setting registers with default true", () => {
  const reg = src.slice(src.indexOf("game.settings.register(MODULE_ID, MUTATION_SETTING"));
  assert.match(reg.slice(0, reg.indexOf("});")), /default: true/);
});
