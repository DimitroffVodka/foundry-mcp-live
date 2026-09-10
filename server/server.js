/**
 * Foundry MCP Server — HTTP transport
 *
 * Entry point. Launches:
 *   - the Foundry-bridge WebSocket server (lib/bridges.js)
 *   - the MCP HTTP server with per-session McpServer instances
 *   - the hot-reload watcher (lib/hot-reload.js)
 *
 * All real logic lives under lib/ and tools/. This file only wires things
 * up and owns the HTTP/MCP transport bookkeeping.
 *
 * Environment variables:
 *   FOUNDRY_WS_PORT           – WebSocket port for Foundry bridge  (default: 3001)
 *   FOUNDRY_WS_HOST           – Bind address for that bridge       (default: 127.0.0.1;
 *                               set 0.0.0.0 to let another device on the LAN connect)
 *   FOUNDRY_MCP_PORT          – HTTP port for MCP clients          (default: 3000)
 *   BRIDGE_TOKEN              – If set, required for HTTP + WS connections
 *   FOUNDRY_WS_TOKEN          – Bridge-only token; overrides BRIDGE_TOKEN for the
 *                               WebSocket half so you can secure a LAN-exposed
 *                               bridge without adding auth to loopback MCP clients.
 *                               Required only of bridges from another machine —
 *                               a Foundry client on this machine connects without it
 *   FOUNDRY_WS_ALLOWED_ORIGINS – Extra browser origins allowed to connect from this
 *                               machine without a token (comma-separated). Loopback
 *                               origins are already allowed
 *   FOUNDRY_MCP_ALLOW_EVAL    – "1" enables the `evaluate` tool (off by default)
 */

import { McpServer }                      from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport }  from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp }            from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID }                     from "crypto";

import { log }                            from "./lib/log.js";
import { HTTP_PORT, BRIDGE_TOKEN, ALLOW_EVAL, SERVER_VERSION, RELAUNCH_CONFIG, RELAY_CONFIG } from "./lib/config.js";
import { createRelayGateway }            from "./lib/relay-gateway.js";
import { setRelayGateway }               from "./lib/relay-runtime.js";
import { startBridgeServer, bridges }     from "./lib/bridges.js";
import { startHotReloadWatcher }          from "./lib/hot-reload.js";
import { registerTools }                  from "./tools/index.js";
import { relaunchClient }                 from "./lib/relaunch.js";
import { createRelaunchSupervisor }       from "./lib/relaunch-supervisor.js";
import { getUsageSnapshot, getUsageLogPath, isUsageTelemetryEnabled } from "./lib/usage-telemetry.js";
import { SERVER_INSTRUCTIONS }          from "./lib/server-instructions.js";

// Start accepting Foundry bridge connections immediately. Bridges that arrive
// before the first MCP client are fine — the bridges Map is module-level state
// shared with `routeBridge`.
startBridgeServer();

// Autonomous client recovery (opt-in via FOUNDRY_RELAUNCH_AUTO=1): watch for the
// configured GM bridge dropping and relaunch the client automatically, with
// backoff. Shares the single relaunch handler with the `relaunch_client` tool,
// so the supervisor and the tool can never double-launch a browser.
const relaunchSupervisor = createRelaunchSupervisor({
  config: RELAUNCH_CONFIG,
  bridges,
  relaunch: relaunchClient,
  logger: log,
});
relaunchSupervisor.start();

// Relay gateway (opt-in): a managed browser that joins Foundry and relays tool
// calls to clients the MCP server cannot reach directly. Startup is
// deliberately non-fatal — it launches a real browser and logs into a world,
// both of which can fail for reasons that shouldn't take the whole server down
// with them. The direct bridge keeps working either way.
if (RELAY_CONFIG.enabled) {
  const gateway = createRelayGateway(RELAY_CONFIG);
  setRelayGateway(gateway);
  gateway.start().catch((err) => {
    log(`ERROR: relay gateway failed to start: ${err?.message || err}`);
    log("Relayed clients are unavailable; the direct bridge is unaffected.");
    setRelayGateway(null);
  });
} else {
  log("Relay gateway OFF (set FOUNDRY_RELAY_ENABLED=1 to reach remote clients).");
}

// ---------------------------------------------------------------------------
// HTTP / MCP server — stateful session management so multiple clients work
// ---------------------------------------------------------------------------
// Each session: { transport, mcp }. The hot-reload watcher iterates `mcp`
// values to upsert tool registrations across every active session on a
// tools/*.js change.
const sessions = new Map(); // sessionId → { transport, mcp }

// Hot-reload: file watcher on tools/ that re-imports and re-registers tools
// across every active session whenever a tool file changes. See
// lib/hot-reload.js for scope (handler-body + schema/desc edits live;
// lib/* changes still need a server restart).
startHotReloadWatcher(() => [...sessions.values()].map(s => s.mcp));

const app = createMcpExpressApp();

// CORS lockdown — reject any cross-origin browser request. CLI clients
// (Codex, Gemini, Claude Code stdio proxy) send no `Origin` header and are
// unaffected. A malicious site visited in another tab CAN'T POST JSON with
// a custom Content-Type without a preflight, but defense-in-depth: reject
// preflights too, and reject any explicit Origin that isn't a loopback.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !LOOPBACK_ORIGIN.test(origin)) {
    res.status(403).json({ error: `Origin not allowed: ${origin}` });
    return;
  }
  // Reflect the localhost origin if present, otherwise no CORS headers
  // (and therefore no cross-origin access).
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    res.status(204).end();
    return;
  }
  next();
});

// Optional token auth. When BRIDGE_TOKEN is unset, behave as before
// (localhost trust). When set, require `Authorization: Bearer <token>`.
if (BRIDGE_TOKEN) {
  app.use("/mcp", (req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || m[1] !== BRIDGE_TOKEN) {
      res.status(401).json({ error: "Invalid or missing bearer token", code: "FML-0004" });
      return;
    }
    next();
  });
  log("BRIDGE_TOKEN set — requiring Authorization: Bearer header on /mcp");
}

if (!ALLOW_EVAL) {
  log("`evaluate` tool DISABLED (set FOUNDRY_MCP_ALLOW_EVAL=1 to enable).");
}

log(isUsageTelemetryEnabled()
  ? `Tool-usage telemetry ON → ${getUsageLogPath()} (read GET /api/usage; set FOUNDRY_MCP_USAGE=0 to disable)`
  : "Tool-usage telemetry OFF (set FOUNDRY_MCP_USAGE=1 to enable).");

// Usage snapshot: live in-memory aggregate of which tools have been called.
// Aggregate-only (no args / eval bodies — those stay in the JSONL log on disk).
// Gated behind the same bearer token as /mcp when one is configured.
app.get("/api/usage", (req, res) => {
  if (BRIDGE_TOKEN) {
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || m[1] !== BRIDGE_TOKEN) {
      res.status(401).json({ error: "Invalid or missing bearer token", code: "FML-0004" });
      return;
    }
  }
  res.json(getUsageSnapshot());
});

// Handle all MCP traffic (POST for messages, GET for SSE streams, DELETE to close)
app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // --- Existing session ---
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // --- Reject non-init requests that have no session ---
  if (req.method !== "POST") {
    res.status(400).json({ error: "No active session. Send an initialize request first." });
    return;
  }

  // --- New session (initialize) ---
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, mcp });
      log(`Session opened  [${id}]  (${sessions.size} active)`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      log(`Session closed  [${transport.sessionId}]  (${sessions.size} active)`);
    }
  };

  const mcp = new McpServer(
    { name: "foundry-vtt", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  await registerTools(mcp);
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(HTTP_PORT, "127.0.0.1", () => {
  log(`MCP HTTP server  listening on http://127.0.0.1:${HTTP_PORT}/mcp`);
  log(`Ready — waiting for Foundry VTT bridge and MCP clients.`);
});
