import test from "node:test";
import assert from "node:assert/strict";

import { loadRegistrars } from "../tools/index.js";

test("loadRegistrars: one module that fails to load costs only its own tools", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    const calls = [];
    const importer = async (file) => {
      if (file === "bad.js") throw new SyntaxError("The requested module '../lib/x.js' does not provide an export named 'y'");
      return { [`register_${file}`]: () => calls.push(file) };
    };
    const registrars = await loadRegistrars([["a.js", "register_a.js"], ["bad.js", "registerBad"], ["c.js", "register_c.js"]], importer);
    assert.equal(registrars.length, 3, "order and count preserved");
    for (const r of registrars) r({});
    assert.deepEqual(calls, ["a.js", "c.js"], "good modules still register; the bad one is a no-op");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /tools\/bad\.js failed to load.*restart the server.*does not provide an export/);
  } finally { console.error = orig; }
});
