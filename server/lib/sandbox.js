/**
 * Throwaway Foundry instances for UI tests.
 *
 * A sandbox is a second Foundry process from the installed app, with its own
 * dataPath under the ui-test cache, its own port in PORT_RANGE, bound to
 * 127.0.0.1, and one world built offline: world.json plus a seeded
 * core.moduleConfiguration that enables the module under test (and the modules
 * it requires). The live instance is only ever read from: its licence file is
 * copied, and its installed system/required modules are staged in.
 *
 * Staging = a real directory of symlinks to the package's top-level entries,
 * except `packs/`, which is copied (reflink where the filesystem has it):
 * Foundry writes into compendium LevelDBs, and must not write into the live
 * install or a module checkout, nor fight the live server for the LOCK file.
 *
 * Env: FOUNDRY_APP (default ~/FoundryV14/app), FOUNDRY_DATA (the live dataPath
 * holding Config/ and Data/; default FOUNDRY_APP/..), FOUNDRY_NODE (node for
 * Foundry; default this process's), FOUNDRY_UI_TEST_CACHE (default
 * tools/ui-test/.cache).
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
         readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SHIM = fileURLToPath(new URL("./loopback-listen.cjs", import.meta.url));
// Clear of the live Foundry (30000), the MCP server (3000/3001) and the e2e runner (30002).
export const PORT_RANGE = [30700, 30799];
export const WORLD_ID = "ui-test";
const SKIP = new Set([".git", "node_modules", ".claude", ".cache", "e2e"]);

export function sandboxPaths(env = process.env) {
  const app = env.FOUNDRY_APP ?? path.join(homedir(), "FoundryV14", "app");
  const cache = env.FOUNDRY_UI_TEST_CACHE ?? path.join(REPO, "tools", "ui-test", ".cache");
  return {
    app,
    data: env.FOUNDRY_DATA ?? path.join(app, ".."),
    cache,
    sandboxes: path.join(cache, "sandboxes"),
    node: env.FOUNDRY_NODE ?? process.execPath,
  };
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function worldJson({ system, systemVersion, release }) {
  const coreVersion = `${release.generation}.${release.build}`;
  return {
    id: WORLD_ID,
    title: "UI Test",
    system,
    coreVersion,
    compatibility: { minimum: String(release.generation), verified: coreVersion },
    systemVersion,
    description: "Throwaway world for foundry-mcp-live ui_test. Deleted when the sandbox stops.",
  };
}

/** Module ids a manifest hard-requires (relationships.requires of type module). */
export function requiredModules(manifest) {
  return (manifest.relationships?.requires ?? [])
    .filter((r) => (r.type ?? "module") === "module")
    .map((r) => r.id);
}

// ponytail: only a top-level packs/ is copied; a manifest pointing packs elsewhere would be written through the symlink.
export function stagePackage(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (SKIP.has(entry)) continue;
    const from = path.join(src, entry), to = path.join(dest, entry);
    if (entry === "packs") execFileSync("cp", ["-r", "--reflink=auto", from, to]);
    else symlinkSync(from, to);
  }
}

async function seedModuleConfiguration(app, worldDir, moduleIds) {
  const { ClassicLevel } = createRequire(path.join(app, "/"))("classic-level");
  const db = new ClassicLevel(path.join(worldDir, "data", "settings"), { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  const _id = "uitestmodcfg0001";
  await db.put(`!settings!${_id}`, JSON.stringify({
    _id, key: "core.moduleConfiguration",
    value: JSON.stringify(Object.fromEntries(moduleIds.map((id) => [id, true]))),
  }));
  await db.close();
}

function isAlive(record) {
  try { return readFileSync(`/proc/${record.pid}/cmdline`, "utf8").includes(`--dataPath=${record.dataPath}`); }
  catch (err) {
    if (err.code !== "ENOENT" || existsSync("/proc/self")) return false;
    try { process.kill(record.pid, 0); return true; } catch { return false; } // no /proc on this OS
  }
}

export function listSandboxes(env = process.env) {
  const { sandboxes } = sandboxPaths(env);
  if (!existsSync(sandboxes)) return [];
  return readdirSync(sandboxes).flatMap((id) => {
    try {
      const record = readJson(path.join(sandboxes, id, "sandbox.json"));
      return [{ ...record, alive: isAlive(record) }];
    } catch { return []; }
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer().once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function pickPort(taken) {
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
    if (!taken.has(p) && await portFree(p)) return p;
  }
  throw new Error(`no free sandbox port in ${PORT_RANGE.join("-")}; stop some sandboxes (ui_test action stop)`);
}

const tail = (file, lines = 25) => {
  try { return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n"); } catch { return ""; }
};

/**
 * Build and launch a sandbox. Resolves once the world is active.
 * @param {{module: string, system?: string, port?: number}} opts  module = path to a module checkout
 */
export async function startSandbox({ module, system, port } = {}, env = process.env) {
  const paths = sandboxPaths(env);
  const moduleDir = path.resolve(module ?? "");
  const manifestFile = path.join(moduleDir, "module.json");
  if (!module || !existsSync(manifestFile)) throw new Error(`no module.json in ${moduleDir}`);
  const manifest = readJson(manifestFile);
  const systemId = system ?? manifest.relationships?.systems?.[0]?.id;
  if (!systemId) throw new Error(`${manifest.id} declares no system; pass system`);
  const systemSrc = path.join(paths.data, "Data", "systems", systemId);
  if (!existsSync(path.join(systemSrc, "system.json"))) throw new Error(`system "${systemId}" is not installed at ${systemSrc}`);
  const license = path.join(paths.data, "Config", "license.json");
  if (!existsSync(license)) throw new Error(`no licence at ${license}; launch Foundry once normally first`);
  const requires = requiredModules(manifest);
  for (const id of requires) {
    if (!existsSync(path.join(paths.data, "Data", "modules", id, "module.json"))) {
      throw new Error(`${manifest.id} requires module "${id}", which is not installed in ${paths.data}/Data/modules`);
    }
  }

  const alive = listSandboxes(env).filter((r) => r.alive);
  if (port !== undefined) {
    if (port < PORT_RANGE[0] || port > PORT_RANGE[1]) throw new Error(`port must be in ${PORT_RANGE.join("-")}`);
    if (alive.some((r) => r.port === port) || !await portFree(port)) throw new Error(`port ${port} is in use`);
  }
  port ??= await pickPort(new Set(alive.map((r) => r.port)));

  const id = `sbx-${port}`;
  const dataPath = path.join(paths.sandboxes, id);
  rmSync(dataPath, { recursive: true, force: true }); // a dead sandbox's leftovers on this port
  mkdirSync(path.join(dataPath, "Config"), { recursive: true });
  copyFileSync(license, path.join(dataPath, "Config", "license.json"));
  writeFileSync(path.join(dataPath, "Config", "options.json"), JSON.stringify({
    port, hostname: "127.0.0.1", upnp: false, telemetry: false, world: WORLD_ID,
  }, null, 2));
  const dataDir = path.join(dataPath, "Data");
  stagePackage(systemSrc, path.join(dataDir, "systems", systemId));
  stagePackage(moduleDir, path.join(dataDir, "modules", manifest.id));
  for (const req of requires) stagePackage(path.join(paths.data, "Data", "modules", req), path.join(dataDir, "modules", req));
  const worldDir = path.join(dataDir, "worlds", WORLD_ID);
  mkdirSync(worldDir, { recursive: true });
  const release = readJson(path.join(paths.app, "package.json")).release;
  writeFileSync(path.join(worldDir, "world.json"), JSON.stringify(worldJson({
    system: systemId, systemVersion: readJson(path.join(systemSrc, "system.json")).version, release,
  }), null, 2));
  await seedModuleConfiguration(paths.app, worldDir, [manifest.id, ...requires]);

  const logFile = path.join(dataPath, "foundry.log");
  const log = openSync(logFile, "a");
  const child = spawn(paths.node, [
    "--require", SHIM, path.join(paths.app, "main.js"),
    `--dataPath=${dataPath}`, `--port=${port}`, `--world=${WORLD_ID}`, "--noupnp", "--noupdate",
  ], {
    cwd: paths.app, detached: true, stdio: ["ignore", log, log],
    env: { PATH: env.PATH, HOME: env.HOME, NODE_ENV: "production" },
  });
  closeSync(log);
  child.unref();
  const record = {
    id, port, pid: child.pid, url: `http://127.0.0.1:${port}`, dataPath, world: WORLD_ID,
    system: systemId, moduleId: manifest.id, moduleDir, modules: [manifest.id, ...requires],
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dataPath, "sandbox.json"), JSON.stringify(record, null, 2));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const status = await fetch(`${record.url}/api/status`).then((r) => r.json()).catch(() => null);
    if (status?.active) return record;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const why = tail(logFile);
  await stopSandbox(id, env);
  throw new Error(`sandbox ${id} never launched its world. Foundry log tail:\n${why}`);
}

/** Stop a sandbox's Foundry (SIGINT, like foundryvtt.service; SIGKILL after 15 s) and delete its dataPath. */
export async function stopSandbox(id, env = process.env) {
  const { sandboxes } = sandboxPaths(env);
  if (!/^sbx-\d+$/.test(id ?? "")) throw new Error(`not a sandbox id: ${id}`);
  const dataPath = path.join(sandboxes, id);
  if (!existsSync(dataPath)) throw new Error(`no sandbox ${id}`);
  let record = null;
  try { record = readJson(path.join(dataPath, "sandbox.json")); } catch { /* half-built: just remove it */ }
  if (record && isAlive(record)) {
    process.kill(record.pid, "SIGINT");
    for (let i = 0; i < 30 && isAlive(record); i++) await new Promise((r) => setTimeout(r, 500));
    if (isAlive(record)) process.kill(record.pid, "SIGKILL");
  }
  rmSync(dataPath, { recursive: true, force: true });
  return { id, stopped: true };
}
