/**
 * `ui_test` — Playwright UI tests for any Foundry module, in a throwaway
 * Foundry sandbox (server/lib/sandbox.js), never the live world. Server-local:
 * no bridge is involved. Registers only when the harness's dependencies are
 * installed (cd tools/ui-test && npm ci), like the design-harness tools.
 *
 * A run takes minutes, so `run` spawns tools/ui-test/run.mjs detached and
 * returns a runId at once; `status` reads <cache>/runs/<runId>/result.json,
 * waiting up to waitMs for it (the evaluate background / job_result pattern,
 * kept on disk so a run outlives a server restart).
 */
import { spawn }                 from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path                      from "node:path";
import { fileURLToPath }         from "node:url";
import { z }                     from "zod";
import { listSandboxes, sandboxPaths, startSandbox, stopSandbox } from "../lib/sandbox.js";
import { registerRawTool }       from "./_helpers.js";

const HARNESS = fileURLToPath(new URL("../../tools/ui-test/", import.meta.url));
const MAX_WAIT_MS = 40_000; // MCP clients give up near 60 s

export const uiTestHarnessReady = () =>
  existsSync(path.join(HARNESS, "node_modules", "@thefehr", "foundry-playwright", "package.json"));

export function buildRunArgs({ module, system, grep, sandbox, keep }, runId) {
  return [
    path.join(HARNESS, "run.mjs"), "--module", path.resolve(module), "--run-id", runId,
    ...(system ? ["--system", system] : []), ...(grep ? ["--grep", grep] : []),
    ...(sandbox ? ["--sandbox", sandbox] : []), ...(keep ? ["--keep"] : []),
  ];
}

const runsDir = () => path.join(sandboxPaths().cache, "runs");
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A run's state from its directory: the result once written, else running/died with the log tail. */
export function readRun(runDir) {
  const result = path.join(runDir, "result.json");
  if (existsSync(result)) return { status: "done", ...JSON.parse(readFileSync(result, "utf8")) };
  if (!existsSync(runDir)) return { status: "unknown", error: `no run at ${runDir}` };
  let pid = null;
  try { pid = Number(readFileSync(path.join(runDir, "run.pid"), "utf8")); } catch { /* not spawned by the tool */ }
  let logTail = "";
  try {
    logTail = readFileSync(path.join(runDir, "run.log"), "utf8").split("\n")
      .filter((l) => l && !l.startsWith("Browser Log:")).slice(-15).join("\n");
  } catch { /* no log yet */ }
  return { status: pid && !pidAlive(pid) ? "died" : "running", runDir, logTail };
}

const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

async function handle({ action, module, system, grep, sandbox, keep, runId, waitMs = 0 }) {
  if (action === "run") {
    if (!module) return reply({ error: "run requires module (path to a module checkout with e2e/*.spec.*)" });
    const id = `run-${Date.now().toString(36)}`;
    const runDir = path.join(runsDir(), id);
    mkdirSync(runDir, { recursive: true });
    const log = openSync(path.join(runDir, "run.log"), "a");
    const child = spawn(process.execPath, buildRunArgs({ module, system, grep, sandbox, keep }, id),
      { cwd: HARNESS, detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    child.unref();
    writeFileSync(path.join(runDir, "run.pid"), String(child.pid));
    return reply({ runId: id, status: "running", runDir,
      next: `ui_test {action: "status", runId: "${id}", waitMs: 40000} until status is "done"` });
  }
  if (action === "status") {
    if (!runId) {
      const runs = existsSync(runsDir()) ? readdirSync(runsDir()) : [];
      const recent = runs.map((id) => ({ id, t: statSync(path.join(runsDir(), id)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(0, 10)
        .map(({ id }) => {
          const r = readRun(path.join(runsDir(), id));
          return { runId: id, status: r.status, ok: r.ok, passed: r.passed, failed: r.failed };
        });
      return reply({ sandboxes: listSandboxes(), runs: recent });
    }
    const runDir = path.join(runsDir(), runId);
    const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
    let state = readRun(runDir);
    while (state.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      state = readRun(runDir);
    }
    return reply(state);
  }
  if (action === "start") {
    if (!module) return reply({ error: "start requires module" });
    try {
      const record = await startSandbox({ module, system });
      return reply({ ...record, next: `open ${record.url} and join as Gamemaster (no password); `
        + `ui_test {action: "run", module, sandbox: "${record.id}"} reuses it; ui_test {action: "stop", sandbox: "${record.id}"} removes it` });
    } catch (err) { return reply({ error: err.message }); }
  }
  if (action === "stop") {
    if (!sandbox) return reply({ error: "stop requires sandbox (an id from ui_test status)" });
    try { return reply(await stopSandbox(sandbox)); } catch (err) { return reply({ error: err.message }); }
  }
  return reply({ error: `unknown action ${action}` });
}

export function registerUiTestTools(mcp) {
  if (!uiTestHarnessReady()) return;
  registerRawTool(mcp, "ui_test",
    "Browser-level Playwright tests for ANY Foundry module, run in a throwaway Foundry sandbox — never the live world. "
    + "A sandbox is a second Foundry from the installed app on its own 127.0.0.1 port (30700-30799) and dataPath, with one "
    + "fresh world of the module's system, the module and its required modules enabled, and a passwordless Gamemaster. "
    + "Specs live in the module repo at e2e/*.spec.{mjs,js,ts} and import { test, expect } from \"@foundry-mcp-live/ui-test\" "
    + "(foundry-playwright fixtures; each test starts joined as Gamemaster). "
    + "action 'run' starts a sandbox, runs the specs, stops it, in the background: returns a runId at once. "
    + "action 'status' with runId waits up to waitMs for the result (ok, passed/failed, per-test status, failure message, "
    + "screenshot/trace paths); without runId lists sandboxes and recent runs. "
    + "action 'start' boots a sandbox and returns its URL (to poke at, or to reuse across runs via `sandbox`); "
    + "action 'stop' kills a sandbox and deletes its data. Present only when the harness is installed (tools/ui-test, npm ci).",
    {
      action:  z.enum(["run", "status", "start", "stop"]).describe("run | status | start | stop"),
      module:  z.string().optional().describe("[run, start] Absolute path to the module checkout (has module.json; specs in e2e/)."),
      system:  z.string().regex(/^[\w-]+$/).optional().describe("[run, start] Game system id, installed in the live Foundry. Default: the module's first relationships.systems entry."),
      grep:    z.string().optional().describe("[run] Only tests whose title matches this regex."),
      sandbox: z.string().regex(/^sbx-\d+$/).optional().describe("[run] Reuse this running sandbox (from start) instead of starting one; it is left running. [stop] The sandbox to stop."),
      keep:    z.boolean().optional().describe("[run] Leave the sandbox the run started running afterwards (stop it yourself)."),
      runId:   z.string().regex(/^run-[\w-]+$/).optional().describe("[status] The run to report."),
      waitMs:  z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("[status] Wait up to this long for a running run to finish. Default 0."),
    },
    handle);
}
