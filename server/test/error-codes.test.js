import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, codedError, codedMessage } from "../lib/errors.js";

// Coverage contract, same shape as docs-tool-coverage: every code in
// ERROR_CODES must have a `## FML-NNNN` section in docs/errors.md, and the doc
// must not describe a code that no longer exists. A catalogue whose entries
// have no fix text is just a rename of the string it replaced.

const ERRORS_MD = readFileSync(
  fileURLToPath(new URL("../../docs/errors.md", import.meta.url)),
  "utf8"
);

function documentedCodes(md) {
  return new Set([...md.matchAll(/^## (FML-\d{4})$/gm)].map((m) => m[1]));
}

// Codes actually referenced from source — catches a `codedError("FML-0009",…)`
// typo'd into existence without a table entry.
function usedCodes() {
  const used = new Set();
  const roots = ["../", "../lib/", "../tools/"];
  for (const rel of roots) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(dir + file, "utf8");
      for (const m of src.matchAll(/"(FML-\d{4})"/g)) used.add(m[1]);
    }
  }
  return used;
}

const DOCUMENTED = documentedCodes(ERRORS_MD);
const DECLARED = new Set(Object.keys(ERROR_CODES));

test("every declared code has a section in docs/errors.md", () => {
  const missing = [...DECLARED].filter((c) => !DOCUMENTED.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `docs/errors.md is missing a \`## FML-NNNN\` section for: ${missing.join(", ")}.`
  );
});

test("docs/errors.md documents no code that ERROR_CODES has dropped", () => {
  const orphaned = [...DOCUMENTED].filter((c) => !DECLARED.has(c)).sort();
  assert.deepEqual(
    orphaned,
    [],
    `docs/errors.md documents code(s) absent from ERROR_CODES: ${orphaned.join(", ")}.`
  );
});

test("every code used in source is declared", () => {
  const undeclared = [...usedCodes()].filter((c) => !DECLARED.has(c)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `Source references undeclared error code(s): ${undeclared.join(", ")}.`
  );
});

test("codedMessage carries the code, the text, and a docs pointer", () => {
  const msg = codedMessage("FML-0001", "No GM bridge connected.");
  assert.match(msg, /^FML-0001: No GM bridge connected\./);
  assert.match(msg, /docs\/errors\.md#fml-0001$/);
});

test("codedError exposes the code on .code as well as in the message", () => {
  const err = codedError("FML-0002", 'No bridge connected for "Bazogo".');
  assert.equal(err.code, "FML-0002");
  assert.match(err.message, /FML-0002/);
  assert.ok(err instanceof Error);
});
