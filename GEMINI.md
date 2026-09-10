# Foundry MCP Live — Gemini CLI Setup

This repo runs an MCP server that lets you (Gemini CLI) talk to a live Foundry VTT instance.

## First-message protocol (read before acting)

On your first interaction in this repo, before doing anything else:

1. Call `mcp_foundry-vtt_list_connected_bridges`.
2. **If it returns a bridge** → the chain is healthy. Proceed with whatever the user asked.
3. **If the tool isn't in your tool list at all** → your MCP client isn't connected to the server. Re-read the setup sections below and tell the user which step is missing. Do **not** web-search for tool names; the tool list is exposed by the server itself.
4. **If the tool errors or returns an empty array** → the HTTP server is reachable but no Foundry world has the `foundry-mcp-live` module active. Tell the user to open Foundry and verify the module is enabled. Do **not** retry blindly or guess.

The tool list is authoritative — every `mcp_foundry-vtt_*` tool you see is real. There are no hidden tools, no resources, no prompts. Don't guess names you can't see; don't search the web for documentation you already have access to.

## Recommended: stdio via the proxy

Gemini CLI's Streamable HTTP support has known tool-discovery issues — the connection succeeds but `tools/list` doesn't always surface to the agent. The repo ships `server/proxy.mjs` precisely for this: it speaks stdio MCP to Gemini and bridges to the HTTP server. Stdio is the original MCP transport and every CLI handles it correctly.

```bash
gemini mcp remove foundry-vtt    # if a broken entry exists
gemini mcp add foundry-vtt -- node "E:\foundry-mcp-live\server\proxy.mjs"
```

Or equivalent in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "command": "node",
      "args": ["E:\\foundry-mcp-live\\server\\proxy.mjs"]
    }
  }
}
```

The HTTP server still needs to be running (`cd server && npm start`) — the proxy just bridges stdio↔HTTP. Cold-restart Gemini after editing config; do **not** rely on `/mcp reload` for fresh tool discovery.

## Alternative: direct HTTP (Streamable HTTP)

If you want to skip the proxy and connect directly:

```bash
gemini mcp add foundry-vtt http://127.0.0.1:3000/mcp
```

The server uses MCP's **Streamable HTTP** transport — single endpoint, POST for messages, GET for the SSE stream *after* `initialize`. It does **not** speak the legacy two-endpoint SSE protocol.

Do **not** pass `--transport sse`. If you do, you'll see:

- `Not Acceptable: Client must accept both application/json and text/event-stream`
- `No active session. Send an initialize request first.`

Both errors mean **wrong transport**, not a server bug. Do not "fix" them with header workarounds.

Equivalent settings.json for direct HTTP:

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "httpUrl": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Use `httpUrl` (Streamable HTTP), **not** `url` (SSE). If tools don't appear after a successful connection, fall back to the stdio proxy above — that path has been verified end-to-end with the same server.

## What this server exposes

**Tools only.** No MCP resources, no prompts. Don't look for `resources/list` or call `read_resource` — there are none. Use the tools directly: `list`, `document`, `scene_read`, `roll`, etc. See `server/TOOLS.md` for the full list.

## After configuring

1. Make sure the MCP server is running: `cd server && npm start` (or `server\start.bat` on Windows)
2. Make sure Foundry is open with the `foundry-mcp-live` module active — you should see an "MCP Bridge connected" notification in Foundry
3. In Gemini: `/mcp reload`
4. The `foundry-vtt` server should show ✓ Connected with the tools loaded

## Verifying

Try `list` with `type: "actor"`. If you get results, you're good.

If still Disconnected:

- Check server logs (terminal running `npm start`) — any errors at connect time?
- `curl http://127.0.0.1:3000/mcp` should return the `Not Acceptable` JSON (proves the server is up)
- If `BRIDGE_TOKEN` is set in the server env, you'll need `Authorization: Bearer <token>` in the Gemini config — but the default is unauthenticated localhost
