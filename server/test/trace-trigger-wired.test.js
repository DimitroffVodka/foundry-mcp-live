import test from "node:test";
import assert from "node:assert/strict";

// The gates are read when lib/config.js loads, so set them before importing the tool.
process.env.FOUNDRY_MCP_ALLOW_WRITE = "";
process.env.FOUNDRY_MCP_ALLOW_EVAL = "1";
const { registerTracingTools } = await import("../tools/tracing.js");
const { PRESET_KEYS } = await import("../lib/workflow-presets.js");

const TOOLS = new Map();
registerTracingTools({ tool: (name, _d, _s, cb) => { TOOLS.set(name, cb); return {}; } });

// triggerRefusal is unit-tested in trace-trigger.test.js; this drives the real
// tool so dropping the call from trace's handler turns the suite red. Refusals
// return before any RPC, so no bridge is needed.
test("trace refuses a write-gated or unrouted trigger before tracing anything", async () => {
  const trace = TOOLS.get("trace");
  assert.ok(trace, "trace tool not registered");
  const run = async (tool) => (await trace({ action: "workflow", preset: PRESET_KEYS[0], trigger: { tool, params: {} } })).content[0].text;
  assert.match(await run("create_actor"), /^Error: trigger refused: .*FOUNDRY_MCP_ALLOW_WRITE/);
  assert.match(await run("create_region"), /^Error: trigger refused: .*not a bridge handler/);
});
