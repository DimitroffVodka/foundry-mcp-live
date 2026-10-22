import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PORT_RANGE, requiredModules, stagePackage, stopSandbox, worldJson } from "../lib/sandbox.js";
import { buildRunArgs, readRun } from "../tools/ui-test.js";
import { summarize } from "../../tools/ui-test/results.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "ui-test-"));

test("sandbox ports stay clear of the live Foundry and the MCP server", () => {
  for (const live of [3000, 3001, 30000, 30002]) {
    assert.ok(live < PORT_RANGE[0] || live > PORT_RANGE[1], `${live} is inside ${PORT_RANGE}`);
  }
});

test("worldJson declares the installed core and system versions", () => {
  const w = worldJson({ system: "shadowdark", systemVersion: "4.0.6", release: { generation: 14, build: 369 } });
  assert.equal(w.id, "ui-test");
  assert.equal(w.system, "shadowdark");
  assert.equal(w.coreVersion, "14.369");
  assert.deepEqual(w.compatibility, { minimum: "14", verified: "14.369" });
  assert.equal(w.systemVersion, "4.0.6");
});

test("requiredModules keeps hard module requirements only", () => {
  assert.deepEqual(requiredModules({}), []);
  assert.deepEqual(requiredModules({ relationships: { requires: [
    { id: "lib-wrapper", type: "module" }, { id: "socketlib" }, { id: "dnd5e", type: "system" },
  ] } }), ["lib-wrapper", "socketlib"]);
});

test("stagePackage symlinks entries, copies packs/, skips repo clutter; stopping the sandbox leaves the source intact", async () => {
  const root = tmp();
  try {
    const src = path.join(root, "my-module");
    mkdirSync(path.join(src, "packs", "items"), { recursive: true });
    mkdirSync(path.join(src, "scripts"), { recursive: true });
    mkdirSync(path.join(src, ".git"));
    mkdirSync(path.join(src, "node_modules"));
    mkdirSync(path.join(src, "e2e"));
    writeFileSync(path.join(src, "module.json"), "{}");
    writeFileSync(path.join(src, "scripts", "main.mjs"), "x");
    writeFileSync(path.join(src, "packs", "items", "000001.ldb"), "pack");

    const cache = path.join(root, "cache");
    const sbx = path.join(cache, "sandboxes", "sbx-30799");
    const dest = path.join(sbx, "Data", "modules", "my-module");
    stagePackage(src, dest);
    assert.ok(lstatSync(path.join(dest, "scripts")).isSymbolicLink());
    assert.ok(lstatSync(path.join(dest, "module.json")).isSymbolicLink());
    assert.ok(!lstatSync(path.join(dest, "packs")).isSymbolicLink(), "packs/ is a copy Foundry may write into");
    assert.equal(readFileSync(path.join(dest, "packs", "items", "000001.ldb"), "utf8"), "pack");
    for (const skipped of [".git", "node_modules", "e2e"]) assert.ok(!existsSync(path.join(dest, skipped)), skipped);

    writeFileSync(path.join(sbx, "sandbox.json"), JSON.stringify({ pid: 2 ** 22 + 1, dataPath: sbx }));
    assert.deepEqual(await stopSandbox("sbx-30799", { FOUNDRY_UI_TEST_CACHE: cache }), { id: "sbx-30799", stopped: true });
    assert.ok(!existsSync(sbx));
    assert.equal(readFileSync(path.join(src, "scripts", "main.mjs"), "utf8"), "x", "symlink targets survive removal");
    await assert.rejects(stopSandbox("../etc", { FOUNDRY_UI_TEST_CACHE: cache }), /not a sandbox id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("buildRunArgs passes only what was given", () => {
  const args = buildRunArgs({ module: "/m", grep: "sheet", keep: true }, "run-x");
  assert.match(args[0], /tools[/\\]ui-test[/\\]run\.mjs$/);
  assert.deepEqual(args.slice(1), ["--module", path.resolve("/m"), "--run-id", "run-x", "--grep", "sheet", "--keep"]);
});

test("readRun: done with a result, died when the runner is gone without one", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "run.pid"), String(2 ** 22 + 1));
    writeFileSync(path.join(dir, "run.log"), "Browser Log: noise\nsandbox sbx-30700 up\n");
    const died = readRun(dir);
    assert.equal(died.status, "died");
    assert.equal(died.logTail, "sandbox sbx-30700 up");
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ok: true, passed: 1 }));
    assert.deepEqual(readRun(dir), { status: "done", ok: true, passed: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("summarize maps Playwright's JSON report to per-test results with module paths", () => {
  const from = "/cache/runs/r/specs", to = "/mod/e2e";
  const report = {
    suites: [{
      title: "sheet.spec.mjs", file: "sheet.spec.mjs",
      specs: [
        { title: "renders", file: "sheet.spec.mjs", line: 3, tests: [{ results: [{ status: "passed", duration: 1200, attachments: [] }] }] },
        { title: "skipped one", file: "sheet.spec.mjs", line: 9, tests: [{ results: [] }] },
      ],
      suites: [{
        title: "tabs",
        specs: [{ title: "switch", file: "sheet.spec.mjs", line: 12, tests: [{ results: [
          { status: "failed", duration: 5, errors: [
            { message: "\x1b[31mTimeout\x1b[39m" },
            { message: `click failed at ${from}/sheet.spec.mjs:14:5` },
          ], attachments: [{ name: "screenshot", path: "/cache/runs/r/artifacts/a.png" }, { name: "stdout" }] },
        ] }] }],
      }],
    }],
    errors: [],
  };
  const s = summarize(report, { from, to });
  assert.equal(s.ok, false);
  assert.deepEqual([s.passed, s.failed, s.skipped], [1, 1, 1]);
  const failed = s.tests.find((t) => t.status === "failed");
  assert.equal(failed.title, "tabs › switch");
  assert.equal(failed.file, "/mod/e2e/sheet.spec.mjs:12");
  assert.equal(failed.error, "Timeout\n\nclick failed at /mod/e2e/sheet.spec.mjs:14:5");
  assert.deepEqual(failed.attachments, ["/cache/runs/r/artifacts/a.png"]);
  assert.equal(s.tests[0].error, undefined);

  assert.equal(summarize({ suites: [], errors: [] }).ok, false, "no tests is not a pass");
  assert.equal(summarize({ suites: report.suites.slice(0, 0), errors: [{ message: "SyntaxError" }] }).errors[0], "SyntaxError");
});
