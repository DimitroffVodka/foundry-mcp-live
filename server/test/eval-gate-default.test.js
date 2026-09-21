/**
 * The `evaluate` gate ships ON. That is a security-relevant default, so it gets
 * a test rather than a comment: a stray refactor back to the opt-in form
 * (`/^(1|true|yes)$/`) silently removes the most-used tool in the surface from
 * every default install, and nothing else in the suite would notice.
 *
 * config.js reads process.env once at import, so each case needs its own
 * process — hence the child rather than a loop over `process.env`.
 */
import { test }           from "node:test";
import assert             from "node:assert/strict";
import { execFileSync }   from "node:child_process";
import { fileURLToPath }  from "node:url";

const CONFIG = fileURLToPath(new URL("../lib/config.js", import.meta.url));

const allowEvalWith = (value) => {
  const env = { ...process.env };
  if (value === undefined) delete env.FOUNDRY_MCP_ALLOW_EVAL;
  else env.FOUNDRY_MCP_ALLOW_EVAL = value;
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e",
     `import { ALLOW_EVAL } from ${JSON.stringify(CONFIG)}; process.stdout.write(String(ALLOW_EVAL));`],
    { env, encoding: "utf8" },
  );
};

test("evaluate is enabled when FOUNDRY_MCP_ALLOW_EVAL is unset", () => {
  assert.equal(allowEvalWith(undefined), "true");
});

test("evaluate is enabled for an empty or affirmative value", () => {
  for (const v of ["", "1", "true", "yes"]) assert.equal(allowEvalWith(v), "true", `value: ${JSON.stringify(v)}`);
});

test("evaluate is disabled only by an explicit off value", () => {
  for (const v of ["0", "false", "no", "off", "OFF"]) assert.equal(allowEvalWith(v), "false", `value: ${v}`);
});
