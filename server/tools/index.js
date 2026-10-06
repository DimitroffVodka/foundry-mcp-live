/**
 * Tool registration orchestrator.
 *
 * Each tools/* module exports a `register*Tools(mcp)` function. We call
 * them all once per MCP session so tool definitions live on the per-session
 * `McpServer` instance.
 *
 * Note: child modules are dynamically-imported with a cache-bust query
 * string on every call, so the hot-reload watcher (lib/hot-reload.js)
 * picks up tools/*.js edits without a server restart. Each call to
 * `registerTools` reads fresh modules from disk.
 *
 * Scope of "fresh-on-call":
 *   - tools/world.js, canvas.js, runtime.js, tracing.js, dice.js,
 *     snapshot.js, server-local.js, recorder.js — re-imported each call.
 *   - tools/_helpers.js + lib/* — NOT cache-busted (transitively cached
 *     once on first import). Edit those and restart the server.
 */
const TOOL_MODULES = [
  ["world.js", "registerWorldTools"],
  ["canvas.js", "registerCanvasTools"],
  ["runtime.js", "registerRuntimeTools"],
  ["tracing.js", "registerTracingTools"],
  ["dice.js", "registerDiceTools"],
  ["snapshot.js", "registerSnapshotTools"],
  ["server-local.js", "registerServerLocalTools"],
  ["world-authoring.js", "registerWorldAuthoringTools"],
  ["recorder.js", "registerRecorderTools"],
];

/**
 * Import each tools module, isolating failures: a module that cannot load (a
 * bad edit, or a hot-reloaded tool importing a name that the cached, non-reloaded
 * lib/ does not have yet) costs only ITS tools, not every tool on every session.
 */
export async function loadRegistrars(table, importer) {
  return Promise.all(table.map(async ([file, name]) => {
    try { return (await importer(file))[name]; }
    catch (err) {
      console.error(`[foundry-mcp] tools/${file} failed to load — its tools are unavailable until it is fixed`
        + `${/does not provide an export/.test(err.message) ? " (lib/ is not hot-reloaded: restart the server)" : ""}: ${err.message}`);
      return () => {};
    }
  }));
}

export async function registerTools(mcp) {
  const cb = `?t=${Date.now()}`;
  const registrars = await loadRegistrars(TOOL_MODULES, (file) => import(`./${file}${cb}`));
  for (const register of registrars) register(mcp);
}
