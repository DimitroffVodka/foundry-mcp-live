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
export async function registerTools(mcp) {
  const cb = `?t=${Date.now()}`;
  const [
    { registerWorldTools },
    { registerCanvasTools },
    { registerRuntimeTools },
    { registerTracingTools },
    { registerDiceTools },
    { registerSnapshotTools },
    { registerServerLocalTools },
    { registerWorldAuthoringTools },
    { registerRecorderTools },
  ] = await Promise.all([
    import("./world.js" + cb),
    import("./canvas.js" + cb),
    import("./runtime.js" + cb),
    import("./tracing.js" + cb),
    import("./dice.js" + cb),
    import("./snapshot.js" + cb),
    import("./server-local.js" + cb),
    import("./world-authoring.js" + cb),
    import("./recorder.js" + cb),
  ]);

  registerWorldTools(mcp);
  registerCanvasTools(mcp);
  registerRuntimeTools(mcp);
  registerTracingTools(mcp);
  registerDiceTools(mcp);
  registerSnapshotTools(mcp);
  registerServerLocalTools(mcp);
  registerWorldAuthoringTools(mcp);
  registerRecorderTools(mcp);
}
