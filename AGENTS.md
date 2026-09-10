# Foundry MCP Live — Agent Setup (Codex CLI and others)

This repo runs an MCP server that lets a connected agent talk to a live Foundry VTT instance.

## First-message protocol (read before acting)

On your first interaction in this repo, before doing anything else:

1. Call `list_connected_bridges` (the exact tool name in your client may be prefixed, e.g. `mcp_foundry-vtt_list_connected_bridges` in Gemini; use whatever form your client exposes).
2. **If it returns one or more bridges** → the chain is healthy. Expect output shaped like:

   ```json
   {
     "bridges": [
       {
         "userName": "Gamemaster",
         "host": "localhost:30000",
         "isGM": true,
         "targetUser": "Gamemaster@localhost:30000"
       }
     ]
   }
   ```

   **If multiple bridges are returned** (e.g. a local and a hosted Foundry world both running), pick one and thread its `targetUser` field through every subsequent tool call. Do not rely on the default GM route when more than one bridge is connected; both may be GM, and the default may not be the world the user intended.
3. **If the tool isn't in your tool list at all** → your MCP client isn't connected to the server. Re-read the setup sections below and tell the user which step is missing. Do **not** web-search for tool names; the tool list is exposed by the server itself.
4. **If the tool errors or returns an empty array** → the HTTP server is reachable but no Foundry world has the `foundry-mcp-live` module active (or the client opted out of auto-connect — see below). Tell the user to open Foundry and verify the module is enabled. Do **not** retry blindly or guess.

The tool list is authoritative. There are no hidden tools, no resources, no prompts. Don't guess names you can't see; don't search the web for documentation you already have access to via `tools/list`.

## This server exposes tools — NOT resources

Common failure mode for fresh agents: looking for MCP **resources** (`resources/list`, `resources/read`) and finding nothing, then concluding the server is empty.

The server registers **zero resources and zero prompts**. Everything is exposed as MCP **tools**. Call tools by name. `tools/list` is the live source of truth; `server/TOOLS.md` is the detailed reference. A few staples to orient with:

- `list`, `document`, `snapshot` — world reads (collections, single docs, before/after actor state)
- `search_compendium`, `get_settings`, `get_data_model`, `get_debug_snapshot`
- `scene_read`, `query_grid`, `screenshot`
- `roll`, `use_item`, `token` (details/move/target/create/update/delete), `apply_damage`, `request`, `combat`
- `get_console_errors`, `bridge_status`, `reload_foundry`, `trace`, `evaluate`
- `list_connected_bridges` — use this first to confirm Foundry is connected

## How the tools are organized

The server currently exposes ~31 tools. **Do not assume one tool per verb** — many related operations are merged behind a single tool that takes an `action` discriminator. Read the tool's own schema; the `action` enum lists the valid modes for that tool.

- **Actors:** `actor_write` (create/update/delete actors and create-from-compendium).
- **World content:** `scene` (create/update/activate/delete scenes) and `combat` (start/advance/end encounters) — each merged tool takes an `action` param, not separate `create_*`/`update_*`/`delete_*` verbs.
- **Tokens:** `token` — one tool, `action` param: move (straight or wall-aware A\* with `pathed: true`), create, update, delete, toggleCondition, target, setLevel.
- **Player-facing requests:** `request` — action roll (dialog, waits for a human click) / check (system-native check, dialogs suppressed) / itemUse (attack→damage workflow). See Mutation caution.

If a name you remember isn't in `tools/list`, it was probably folded during the 96→67 and 68→31 consolidations — check the merged tool's `action` enum rather than guessing the old name.

## Choosing a tool — don't default to `evaluate`

`evaluate` runs arbitrary JavaScript in the Foundry client and is **only present when `FOUNDRY_MCP_ALLOW_EVAL=1`**. When a dedicated tool covers what you need, prefer it: the dedicated tools encode system correctness that hand-rolled `evaluate` gets subtly wrong — `apply_damage` clamps HP at the system level, `token` move routes around walls, `use_item` runs the system's attack/crit logic — and the write tools carry audit/undo. Use `evaluate` only when no tool covers the need, and check `tools/list` first. (If you find yourself reaching for `evaluate` for something a tool should handle, that's worth telling the user — it usually means a tool description needs sharpening.)

## Transport

`http://127.0.0.1:3000/mcp` — MCP **Streamable HTTP** transport (single endpoint; POST/GET/DELETE on `/mcp`). Not legacy SSE.

## Codex CLI configuration

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.foundry]
url = "http://127.0.0.1:3000/mcp"
```

Per-tool approval prompts (optional — useful for tools that mutate state or run arbitrary code):

```toml
[mcp_servers.foundry.tools.evaluate]
approval_mode = "approve"

[mcp_servers.foundry.tools.document]
approval_mode = "approve"
```

Restart Codex after editing. The server should appear in the MCP list with tools loaded. The status line `Auth: Unsupported` is **normal** for local unauthenticated use — it only matters if `BRIDGE_TOKEN` is set on the server (see below).

## Prerequisites for connection

1. MCP server is running: `cd server && npm start` (or `server\start.bat` on Windows). Default port 3000.
2. Foundry VTT is open with the `foundry-mcp-live` module active. The module connects to the server's WebSocket bridge on port 3001.
3. The connecting Foundry client has **"Auto-connect to MCP server"** enabled (module setting, default on) — or is the dedicated headless bridge client, which always connects. A play client with auto-connect off can connect on demand from the console with `mcpBridge.reconnect()`.
4. `list_connected_bridges` returns at least one bridge — confirms the Foundry-side handshake worked.

## If `BRIDGE_TOKEN` is set

The server's env may set `BRIDGE_TOKEN=<secret>`. In that case every request to `/mcp` must include `Authorization: Bearer <secret>`. Codex doesn't have a per-server header config — start the server without `BRIDGE_TOKEN` for local use, or use the stdio proxy (`server/proxy.mjs`) which can read the token from env.

## Multi-GM routing

If multiple Foundry users with the same name are connected (e.g. two GMs on different worlds), use the `targetUser` parameter on tool calls. Get valid targets from `list_connected_bridges` and prefer the returned `targetUser` value. Examples: `"Gamemaster@localhost:30000"`, `"Gamemaster@shadowfoundry.online"`. Omit `targetUser` only when the default GM route is definitely the intended world.

## Mutation caution

Some tools change live Foundry state — they alter what GMs and players see in the open world. Before calling any of these, identify the target token/actor explicitly (read first) and pass `targetUser` if multiple bridges are connected.

There are **three independent gates** on mutation, all of which must allow the call:

1. **Server env gate.** World-authoring tools (`actor_write`, `combat`, `scene`, `apply_damage`, `request`, `self_test`) are registered only when `FOUNDRY_MCP_ALLOW_WRITE=1`; `chat` action 'send' requires the same gate at call time (the read is always available). `token` actions (move/create/update/delete/toggleCondition/target/setLevel) and `interact` are always registered — the per-world read-only toggle (gate 2) is what keeps a closed world safe. If a write tool isn't in your tool list, the gate is off **by design** — tell the user to set the env var rather than retrying. `evaluate` / `job_result` likewise require `FOUNDRY_MCP_ALLOW_EVAL=1`.
2. **Per-world read-only toggle.** The GM can flip a module setting, **"Allow AI to modify the world"** (default on), to make the bridge read-only without restarting the server. When it's off, every mutating tool refuses at the server's audit chokepoint even though the tool is still listed. If a mutation is rejected for this reason, tell the user to re-enable the setting — don't retry.
3. **No undo on deletes.** Foundry has no undo for delete actions (`scene`/`actor_write` with `action: "delete"`, `token` action 'delete', …). Confirm the target with a read first; there is no recovery.

The `request` tool pops a dialog on the **target user's** screen for its roll action and waits for a human to click. If you target a player without an active browser, the dialog never shows and the call times out — target a user you know is connected, or use `autoAccept` for unattended/test runs.

The reads `get_combat` and `chat` action 'read' are **not** gated — available regardless of `FOUNDRY_MCP_ALLOW_WRITE`.

**Read-only, safe to explore with:** `list`, `document`, `scene_read`, `query_grid`, `search_compendium`, `get_settings`, `get_data_model`, `get_debug_snapshot`, `snapshot` (take/diff), `screenshot`, `get_console_errors`, `trace`, `bridge_status`, `list_connected_bridges`.

## Quick smoke test

After configuration, in order. If multiple bridges are connected, pick one `targetUser` from step 1 and reuse it on steps 2–4.

1. `list_connected_bridges` — non-empty means Foundry is reachable. Grab the `targetUser` you want to use.
2. `get_game_info` (with `targetUser`) — confirms Foundry version, system id, active world, and active users in one read-only call.
3. `list {type:"actor"}` (with same `targetUser`) — confirms tool calls reach Foundry and data comes back.
4. `scene_read` (with same `targetUser`) — sanity check on read-only state queries against the active scene.

If those four work, the integration is healthy.
