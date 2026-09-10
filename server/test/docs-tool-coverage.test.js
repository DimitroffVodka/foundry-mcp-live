import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Coverage contract: server/TOOLS.md must document EVERY registered tool, and
// must not keep a section for a tool that no longer exists. This is the inverse
// of docs-tool-names (which guards AGENTS.md against naming dead tools) — here
// the failure mode is a *missing* (or orphaned) reference section. It would
// have caught the 11 tools that had no section before this pass.
//
// Note: TOOLS.md legitimately names dead tools inside "Merges the old X" notes,
// so we deliberately do NOT run the no-dead-names check against it — only this
// section-level coverage check, which the migration prose can't trip.

// Authoritative tool set — parsed from the register*Tool(mcp, "name", …) calls
// that build tools/list. (Identical parser to docs-tool-names.test.js.)
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

// Tool sections in TOOLS.md are level-3 headings whose text starts with a
// backticked name, e.g. `### \`get_actor\`` or `### \`combat\` (write — opt-in)`.
function documentedTools(md) {
  const names = new Set();
  for (const m of md.matchAll(/^### `([a-z_]+)`/gm)) names.add(m[1]);
  return names;
}

// `### \`name\`` headings that document a universal *parameter*, not a tool.
// (`targetUser` has an uppercase letter so the lowercase regex already skips it.)
const NON_TOOL_HEADINGS = new Set(["audit"]);

const REGISTERED = registeredTools();
const TOOLS_MD = readFileSync(fileURLToPath(new URL("../TOOLS.md", import.meta.url)), "utf8");
const DOCUMENTED = documentedTools(TOOLS_MD);

test("tool registrations parse to a plausible set (guards a broken regex)", () => {
  assert.ok(REGISTERED.size >= 30, `only parsed ${REGISTERED.size} tools — registration regex likely drifted`);
});

test("every registered tool has a section in TOOLS.md", () => {
  const missing = [...REGISTERED].filter((t) => !DOCUMENTED.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `TOOLS.md is missing a \`### \`tool\`\` section for: ${missing.join(", ")}. ` +
    `Add a section (description + params) for each new tool.`
  );
});

test("TOOLS.md has no section for a tool that no longer exists", () => {
  const orphaned = [...DOCUMENTED].filter(
    (t) => !REGISTERED.has(t) && !NON_TOOL_HEADINGS.has(t)
  ).sort();
  assert.deepEqual(
    orphaned,
    [],
    `TOOLS.md documents tool(s) that aren't registered in server/tools/*.js: ${orphaned.join(", ")}. ` +
    `Remove the stale section, or add it to NON_TOOL_HEADINGS if it documents a param/concept rather than a tool.`
  );
});
