#!/usr/bin/env node
/**
 * Run the E2E smoke test locally, against your own Foundry install.
 *
 *   npm run e2e
 *
 * No licence key, no secrets, no container, no CI. This stands up a second
 * Foundry from the install you already have, on its own port with its own
 * dataPath, pointed at the fixture world. Your running game is untouched: a
 * different port, a different data directory, and a different world.
 *
 * What it needs:
 *   - Foundry installed locally (set FOUNDRY_APP if it is not in the usual place)
 *   - Chromium or Chrome (set FOUNDRY_CHROME_PATH to override)
 *   - The MCP server running, because that is the bridge under test
 *
 * Env:
 *   FOUNDRY_APP           path to Foundry's app dir  (default: ~/FoundryV14/app)
 *   FOUNDRY_E2E_PORT      port for the throwaway instance (default: 30002)
 *   FOUNDRY_CHROME_PATH   browser binary (default: /usr/bin/chromium)
 *   E2E_KEEP=1            keep the scratch dataPath and leave Foundry running
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const PORT = process.env.FOUNDRY_E2E_PORT ?? "30002";
const CHROME = process.env.FOUNDRY_CHROME_PATH ?? "/usr/bin/chromium";
const KEEP = /^(1|true|yes)$/i.test(process.env.E2E_KEEP ?? "");

// An explicitly set FOUNDRY_APP is authoritative. Treating it as merely the
// first guess in a fallback chain means a typo'd path silently tests whatever
// Foundry happens to be in the default location — the wrong install, with no
// indication anything was ignored.
const APP_CANDIDATES = process.env.FOUNDRY_APP
  ? [process.env.FOUNDRY_APP]
  : [
      join(homedir(), "FoundryV14", "app"),
      join(homedir(), "foundryvtt", "resources", "app"),
      "/opt/foundryvtt/resources/app",
    ];

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// --- Preflight. Every one of these fails clearly rather than 90s later. -----
const app = APP_CANDIDATES.find((p) => existsSync(join(p, "main.js")));
if (!app) {
  fail(`Could not find Foundry. Set FOUNDRY_APP to the directory containing main.js.\n`
     + `  Tried: ${APP_CANDIDATES.join(", ")}`);
}
// Foundry keeps Config/ and Data/ as siblings of app/.
const install = join(app, "..");
const license = join(install, "Config", "license.json");
if (!existsSync(license)) {
  fail(`No licence found at ${license}. Launch Foundry once normally first — this\n`
     + `  reuses the licence you already activated, it does not need a new key.`);
}
if (!existsSync(CHROME)) {
  fail(`No browser at ${CHROME}. Set FOUNDRY_CHROME_PATH.`);
}

// The bridge is the thing under test; without the MCP server there is nothing
// for the module to connect back to.
const mcpUp = await fetch("http://127.0.0.1:3000/api/usage")
  .then((r) => r.ok)
  .catch(() => false);
if (!mcpUp) {
  fail(`The MCP server is not answering on 127.0.0.1:3000.\n`
     + `  Start it:  systemctl --user start foundry-mcp-live.service\n`
     + `  or:        cd server && npm start`);
}

// --- Assemble a throwaway Foundry data directory ---------------------------
const scratch = await mkdtemp(join(tmpdir(), "fml-e2e-"));
console.log(`scratch dataPath: ${scratch}`);

await mkdir(join(scratch, "Config"), { recursive: true });
await mkdir(join(scratch, "Data", "systems"), { recursive: true });
await mkdir(join(scratch, "Data", "modules"), { recursive: true });
await mkdir(join(scratch, "Data", "worlds"), { recursive: true });

await cp(license, join(scratch, "Config", "license.json"));
const admin = join(install, "Config", "admin.txt");
if (existsSync(admin)) await cp(admin, join(scratch, "Config", "admin.txt"));

// The fixture declares a system, so that system has to be present. Symlink it
// from the real install rather than copying tens of megabytes per run.
const world = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile(join(HERE, "fixtures", "worlds", "mcp-smoke", "world.json"), "utf8"))
);
const systemSrc = join(install, "Data", "systems", world.system);
if (!existsSync(systemSrc)) {
  fail(`The fixture world needs the "${world.system}" system, which is not installed at\n`
     + `  ${systemSrc}\n  Install it in Foundry once, or edit the fixture's world.json.`);
}
await symlink(systemSrc, join(scratch, "Data", "systems", world.system), "dir");

// The module under test, live from the checkout.
await symlink(join(REPO, "module"), join(scratch, "Data", "modules", "foundry-mcp-live"), "dir");

// The fixture world, copied because Foundry writes into it.
await cp(join(HERE, "fixtures", "worlds", "mcp-smoke"),
         join(scratch, "Data", "worlds", "mcp-smoke"), { recursive: true });

// --- Launch, test, tear down ----------------------------------------------
console.log(`launching Foundry ${world.coreVersion ?? ""} on :${PORT} (world "${world.id}")`);
const foundry = spawn(process.execPath, [
  join(app, "main.js"),
  `--dataPath=${scratch}`,
  `--port=${PORT}`,
  `--world=${world.id}`,
  "--noupnp",
  "--noupdate",
], { stdio: ["ignore", "pipe", "pipe"] });

const foundryLog = [];
foundry.stdout.on("data", (d) => foundryLog.push(d.toString()));
foundry.stderr.on("data", (d) => foundryLog.push(d.toString()));

const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 90; i++) {
  if (foundry.exitCode !== null) break;
  try {
    const r = await fetch(`${base}/api/status`);
    if (r.ok && (await r.text()).includes('"active":true')) { up = true; break; }
  } catch { /* still booting */ }
  await new Promise((r) => setTimeout(r, 1000));
}

let code = 1;
if (!up) {
  console.error("\n✗ Foundry never launched the world. Last output:\n");
  console.error(foundryLog.join("").split("\n").slice(-20).join("\n"));
} else {
  console.log("world is up — running the smoke test\n");
  code = await new Promise((resolve) => {
    const smoke = spawn(process.execPath, [join(HERE, "foundry-smoke.mjs")], {
      stdio: "inherit",
      env: {
        ...process.env,
        FOUNDRY_E2E_URL: base,
        FOUNDRY_E2E_GM_USER: "Gamemaster",
        FOUNDRY_CHROME_PATH: CHROME,
      },
    });
    smoke.on("close", resolve);
  });
}

if (KEEP) {
  console.log(`\nE2E_KEEP set — Foundry still running on ${base}, dataPath ${scratch}`);
  console.log(`stop it with: kill ${foundry.pid}`);
} else {
  foundry.kill();
  await rm(scratch, { recursive: true, force: true });
}
process.exit(code);
