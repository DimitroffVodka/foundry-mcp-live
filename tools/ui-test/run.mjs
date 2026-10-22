#!/usr/bin/env node
/**
 * Run a module's Playwright specs (<module>/e2e/*.spec.{mjs,js,ts}) in a
 * throwaway Foundry sandbox:
 *
 *   node tools/ui-test/run.mjs --module ~/git/my-module [--system shadowdark]
 *        [--grep "sheet"] [--sandbox sbx-30700] [--keep] [--run-id <id>]
 *
 * Starts a sandbox (server/lib/sandbox.js) unless --sandbox names a running
 * one, copies the specs into the harness so they import its Playwright, runs
 * them, writes <cache>/runs/<id>/result.json, and stops the sandbox it started
 * (unless --keep). Exit code 0 only when every test passed.
 * FOUNDRY_CHROME_PATH picks the browser (default /usr/bin/chromium when present,
 * else Playwright's own: `npx playwright install chromium`).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { listSandboxes, sandboxPaths, startSandbox, stopSandbox } from "../../server/lib/sandbox.js";
import { summarize } from "./results.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  module: { type: "string" }, system: { type: "string" }, grep: { type: "string" },
  sandbox: { type: "string" }, keep: { type: "boolean" }, "run-id": { type: "string" },
} });

const runId = args["run-id"] ?? `run-${Date.now().toString(36)}`;
const runDir = path.join(sandboxPaths().cache, "runs", runId);
mkdirSync(runDir, { recursive: true });
const finish = (result) => {
  const full = { runId, runDir, finishedAt: new Date().toISOString(), ...result };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(full, null, 2));
  console.log(`\nresult: ${path.join(runDir, "result.json")}`);
  process.exit(full.ok ? 0 : 1);
};

const moduleDir = path.resolve(args.module ?? "");
const specDir = path.join(moduleDir, "e2e");
if (!args.module || !existsSync(specDir) || !readdirSync(specDir).some((f) => /\.(spec|test)\.(m?js|ts)$/.test(f))) {
  finish({ ok: false, errors: [`no specs: expected <module>/e2e/*.spec.{mjs,js,ts} in ${moduleDir}`] });
}

let sandbox;
try {
  sandbox = args.sandbox
    ? listSandboxes().find((s) => s.id === args.sandbox && s.alive)
    : await startSandbox({ module: moduleDir, system: args.system });
  if (!sandbox) throw new Error(`sandbox ${args.sandbox} is not running`);
} catch (err) {
  finish({ ok: false, module: moduleDir, errors: [err.message] });
}
console.log(`sandbox ${sandbox.id} at ${sandbox.url} (${sandbox.system}, ${sandbox.moduleId})`);

const specs = path.join(runDir, "specs");
cpSync(specDir, specs, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
const chrome = process.env.FOUNDRY_CHROME_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : "");
const code = await new Promise((resolve) => {
  spawn(process.execPath, [
    path.join(HERE, "node_modules", "@playwright", "test", "cli.js"), "test",
    "--config", path.join(HERE, "playwright.config.mjs"),
    ...(args.grep ? ["--grep", args.grep] : []),
  ], {
    cwd: runDir, stdio: "inherit",
    env: { ...process.env, UI_TEST_SPECS: specs, UI_TEST_OUT: runDir, UI_TEST_CHROME: chrome,
           FOUNDRY_URL: sandbox.url, FOUNDRY_SYSTEM_ID: sandbox.system },
  }).on("close", resolve);
});

if (!args.sandbox && !args.keep) await stopSandbox(sandbox.id).catch((err) => console.error(`stop failed: ${err.message}`));
let summary;
try {
  summary = summarize(JSON.parse(readFileSync(path.join(runDir, "report.json"), "utf8")), { from: specs, to: specDir });
} catch {
  summary = { ok: false, errors: [`playwright exited ${code} without a report; see the run log`] };
}
finish({
  ...summary, module: moduleDir, system: sandbox.system,
  sandbox: args.sandbox || args.keep ? sandbox : { id: sandbox.id, stopped: true },
});
