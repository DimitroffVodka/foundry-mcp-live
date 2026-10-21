import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { triggerRefusal, WRITE_GATED_HANDLERS } from "../tools/tracing.js";
import { RELAY_TOOLS } from "../../module/lib/relay-guard.js";

const OFF = { write: false, eval: true, selfTest: false };
const ON  = { write: true,  eval: true, selfTest: false };

test("trace trigger: handlers no server tool routes to are refused", () => {
  for (const dead of ["create_region", "set_actor_ownership", "add_scene_level", "nope"]) {
    assert.match(triggerRefusal(dead, ON), /not a bridge handler/, dead);
  }
});

test("trace trigger: ungated handlers fire with the write gate off", () => {
  assert.equal(triggerRefusal("use_item", OFF), null);
  assert.equal(triggerRefusal("roll", OFF), null);
});

test("trace trigger: changes_undo is never a trigger (the changes tool supplies its env gate)", () => {
  assert.match(triggerRefusal("changes_undo", ON), /cannot be a trigger/);
  assert.equal(triggerRefusal("changes_list", OFF), null);
});

test("trace trigger: write handlers need FOUNDRY_MCP_ALLOW_WRITE", () => {
  assert.match(triggerRefusal("create_actor", OFF), /ALLOW_WRITE/);
  assert.match(triggerRefusal("send_chat_message", OFF), /ALLOW_WRITE/);
  assert.equal(triggerRefusal("create_actor", ON), null);
  assert.match(triggerRefusal("self_test", ON), /SELF_TEST/);
  assert.match(triggerRefusal("evaluate", { ...ON, eval: false }), /ALLOW_EVAL/);
});

test("trace trigger: every handler world-authoring.js routes to is write-gated", () => {
  const src = readFileSync(new URL("../tools/world-authoring.js", import.meta.url), "utf8");
  // "roll" there is request's action name, not the dice handler; self_test has its own gate.
  const routed = [...new Set([...src.matchAll(/["'`]([a-z_]+)["'`]/g)].map(m => m[1]))]
    .filter(n => RELAY_TOOLS.has(n) && n !== "roll" && n !== "self_test");
  assert.deepEqual(routed.filter(n => !WRITE_GATED_HANDLERS.has(n)), []);
  for (const n of WRITE_GATED_HANDLERS) assert.ok(RELAY_TOOLS.has(n), n);
});
