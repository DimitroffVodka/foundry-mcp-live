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
  "initialize",        // GEMINI.md: MCP handshake method
  "url",               // GEMINI.md: Gemini settings key
  "read_resource",     // GEMINI.md: named only to say there are no resources
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
  { label: "GEMINI.md", text: readFileSync(fileURLToPath(new URL("../../GEMINI.md", import.meta.url)), "utf8"), minKnown: 3 },
  // server/TOOLS.md is deliberately excluded: its "Merges the old X" notes name
  // dead tools on purpose. docs-tool-coverage.test.js guards it instead.
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

// Tool and param descriptions are the other text every client reads (via
// tools/list), so check the exact strings: register the real tool set into a
// capturing fake. Gates on so gated tools are covered — set before the dynamic
// import, since lib/config.js reads them once at load.
for (const gate of ["EVAL", "WRITE", "SELF_TEST"]) process.env[`FOUNDRY_MCP_ALLOW_${gate}`] = "1";
const { registerTools } = await import("../tools/index.js");
const TOOLS = [];
await registerTools({ tool: (name, description, schema) => { TOOLS.push({ name, description, schema }); return {}; } });

// Descriptions routinely backtick their own params (`type`, `rig`) and enum
// values (`summary`), so every tool's param names and enum values count as
// known — plus the JS names evaluate's description documents. Caveat: a dead
// tool whose name is now also a param (`folder`, `region`) can't be caught.
const DESCRIPTION_KNOWN = new Set(["game", "ui", "return", "await"]);
const DESCRIPTIONS = [];
const unwrapOptional = (t) => { while (t?._def?.innerType) t = t._def.innerType; return t; };
for (const { name, description, schema } of TOOLS) {
  DESCRIPTIONS.push({ where: name, text: description });
  for (const [param, type] of Object.entries(schema ?? {})) {
    DESCRIPTION_KNOWN.add(param);
    for (const value of unwrapOptional(type)?.options ?? []) DESCRIPTION_KNOWN.add(String(value));
    if (type.description) DESCRIPTIONS.push({ where: `${name}.${param}`, text: type.description });
  }
}

test("tool and param descriptions reference no tool that doesn't exist", () => {
  assert.ok(TOOLS.length >= 30, `captured only ${TOOLS.length} tools — the registerTools capture is broken`);
  assert.ok(
    DESCRIPTIONS.length > TOOLS.length + 100,
    `captured only ${DESCRIPTIONS.length - TOOLS.length} param descriptions — zod .description access probably drifted`
  );

  const unknown = DESCRIPTIONS.flatMap(({ where, text }) =>
    [...inlineToolCandidates(text)]
      .filter((t) => !REGISTERED.has(t) && !DESCRIPTION_KNOWN.has(t) && !NON_TOOL_IDENTIFIERS.has(t.toLowerCase()))
      .map((t) => `${where}: ${t}`)
  );
  assert.deepEqual(
    unknown,
    [],
    `description(s) name tool(s) not registered in server/tools/*.js: ${unknown.join("; ")}. ` +
    `Either the name is stale (fix the description) or it's a non-param identifier (add it to DESCRIPTION_KNOWN).`
  );
});
