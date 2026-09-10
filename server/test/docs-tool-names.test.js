import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SERVER_INSTRUCTIONS } from "../lib/server-instructions.js";

// Contract test: the agent-facing docs must never name a tool that doesn't
// exist. This freezes the manual grep/comm check that caught AGENTS.md drifting
// to pre-consolidation names — so the next stale reference fails CI instead of
// being discovered by an agent at runtime.

// Authoritative tool set — parsed from the same register*Tool(mcp, "name", ...)
// calls that build tools/list. Gated tools (evaluate, actor_write, …) count as
// existing: the gate is a runtime concern, the NAME is always valid.
function registeredTools() {
  const toolsDir = fileURLToPath(new URL("../tools/", import.meta.url));
  const re = /register(?:Routed|Raw|Merged)Tool\(\s*mcp\s*,\s*"([a-z_]+)"/g;
  const names = new Set();
  for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(toolsDir + file, "utf8");
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

// Inline-code identifiers the docs use that are deliberately NOT tools: tool
// params, settings/config keys, and names referenced only to say they no longer
// exist. Keep this tight — a new entry should make you re-confirm the doc meant
// a param/setting and not a dead tool.
const NON_TOOL_IDENTIFIERS = new Set([
  "action",            // discriminator param on the merged tools
  "phase",             // request itemUse param
  "pathed",            // move_token param
  "autoaccept",        // request_* param (matched case-insensitively below)
  "autoconnect",       // module setting
  "allowworldmutations", // module setting
  "nocanvas",          // core setting
  "move_token_pathed", // referenced only to say it was folded into move_token
]);

// Bare snake_case identifiers from INLINE `code` spans only. Fenced ``` blocks
// hold TOML/JSON config examples full of non-tool tokens, so strip them first.
function inlineToolCandidates(md) {
  const noFences = md.replace(/```[\s\S]*?```/g, "");
  const out = new Set();
  for (const m of noFences.matchAll(/`([^`]+)`/g)) {
    const tok = m[1];
    // a single all-lowercase identifier: no wildcard, dot, colon, slash, space
    if (/^[a-z][a-z0-9_]*$/.test(tok)) out.add(tok);
  }
  return out;
}

const REGISTERED = registeredTools();

const DOCS = [
  { label: "AGENTS.md", text: readFileSync(fileURLToPath(new URL("../../AGENTS.md", import.meta.url)), "utf8"), minKnown: 15 },
  // The one text a pure MCP client actually reads (sent at initialize) — shorter,
  // so a lower non-vacuous floor.
  { label: "server instructions", text: SERVER_INSTRUCTIONS, minKnown: 5 },
  // NOTE: server/TOOLS.md is intentionally excluded until its pending cleanup —
  // it still carries pre-consolidation names. Add it here once it's regenerated.
];

test("tool registrations parse to a plausible set (guards a broken regex)", () => {
  assert.ok(REGISTERED.size >= 30, `only parsed ${REGISTERED.size} tools — registration regex likely drifted`);
  for (const staple of ["list", "document", "token", "request", "trace", "snapshot", "interact", "chat", "scene_read", "actor_write", "evaluate"]) {
    assert.ok(REGISTERED.has(staple), `expected staple tool "${staple}" among registrations`);
  }
});

for (const doc of DOCS) {
  test(`${doc.label} references no tool that doesn't exist`, () => {
    const candidates = [...inlineToolCandidates(doc.text)];

    // Non-vacuous guard: the doc really must mention a healthy number of real
    // tools, otherwise a broken extractor would make the check below pass on
    // an empty set.
    const knownReferenced = candidates.filter((t) => REGISTERED.has(t));
    assert.ok(
      knownReferenced.length >= doc.minKnown,
      `${doc.label}: matched only ${knownReferenced.length} real tool references — the inline-code extractor is probably broken`
    );

    const unknown = candidates.filter(
      (t) => !REGISTERED.has(t) && !NON_TOOL_IDENTIFIERS.has(t.toLowerCase())
    );
    assert.deepEqual(
      unknown,
      [],
      `${doc.label} names tool(s) not registered in server/tools/*.js: ${unknown.join(", ")}. ` +
      `Either the name is stale (fix the doc) or it's a param/setting (add it to NON_TOOL_IDENTIFIERS).`
    );
  });
}
