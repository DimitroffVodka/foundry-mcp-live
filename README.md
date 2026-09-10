# Foundry MCP Live

Connect any MCP-compatible AI client (Claude Desktop, Claude Code, Codex CLI, Gemini CLI) directly to a running Foundry VTT instance. Get live access to actors, compendiums, modules, console errors, and the full game API — no copy-pasting data, no API tokens.

> Released as `foundry-mcp-live` (the Foundry module id and the GitHub repo name match). The id was renamed in v0.7.0 to avoid a collision with an unrelated module in Foundry's package directory; v0.7.1 renamed the repo to match.

## Architecture

```
                          Claude Desktop ─(stdio)─► proxy.mjs ──┐
                                                                │
                          Claude Code  ─────(HTTP)─────────────►│
                                                                ├──► MCP Server
                          Codex CLI    ─────(HTTP)─────────────►│  (HTTP:3000)
                                                                │      │
                          Gemini CLI   ─────(HTTP)─────────────►┘      │
                                                                       ▼
                                                              ◄─(WS:3001)─►
                                                              Foundry browser
```

- **MCP Server** (`server/server.js`, Node.js) — Runs locally on `http://127.0.0.1:3000/mcp` (MCP HTTP transport) and `ws://127.0.0.1:3001` (Foundry bridge). Must be started manually and kept running.
- **Foundry Module** (`module/`, browser JS) — Connects to the WebSocket server on load. Handles tool requests against the live `game` object.
- **stdio proxy** (`server/proxy.mjs`) — Bridge for clients that only speak stdio MCP (Claude Desktop, Claude Code).

## Repo layout

```
foundry-mcp-live/
├── module/    ← Foundry VTT module (copy/symlink into Foundry's modules dir)
└── server/    ← Node.js MCP server (run locally with npm start)
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/DimitroffVodka/foundry-mcp-live.git
cd foundry-mcp-live/server
npm install
```

### 2. Install the Foundry module

In Foundry: **Add-on Modules → Install Module** → paste this manifest URL:

```
https://github.com/DimitroffVodka/foundry-mcp-live/releases/latest/download/module.json
```

Foundry downloads and installs it like any other module. Activate it in your world's Module Management.

<details>
<summary>Manual install (if you can't use the manifest URL)</summary>

Copy or symlink the `module/` folder from this repo into your Foundry modules directory, renaming it to `foundry-mcp-live`:

- **Windows:** `%localappdata%\FoundryVTT\Data\modules\foundry-mcp-live`
- **Linux:** `/home/foundry/foundrydata/Data/modules/foundry-mcp-live`
- **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/foundry-mcp-live`

</details>

### 3. Start the MCP server

The server is HTTP-based and must be running before any client connects:

```bash
cd server
npm start
# or on Windows: server\start.bat
# or on macOS/Linux: ./start.sh
```

You should see:
```
[foundry-mcp] WebSocket server listening on ws://localhost:3001
MCP HTTP server  listening on http://127.0.0.1:3000/mcp
```

Keep this terminal open. The server auto-reloads tool files but other changes need a restart.

#### Optional: run on Linux login/boot with systemd

For a Linux workstation or small dedicated host, install the included user service:

```bash
./scripts/install-linux-user-service.sh
```

This creates:

- `~/.config/systemd/user/foundry-mcp-live.service` — a user-level systemd service that runs `server/server.js` from this checkout.
- `~/.config/foundry-mcp-live/server.env` — optional environment overrides for ports, write/eval gates, bridge token, and relaunch settings.

Useful commands:

```bash
systemctl --user status foundry-mcp-live.service
journalctl --user -u foundry-mcp-live.service -f
systemctl --user restart foundry-mcp-live.service
systemctl --user disable --now foundry-mcp-live.service
```

User services normally start when you log in. To start this service at machine boot before login, enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

The systemd service keeps the same safe defaults as `npm start`: write, eval, self-test, and relaunch tools stay off unless you uncomment or add the matching variables in `~/.config/foundry-mcp-live/server.env`.

#### Optional: enable opt-in tools

Power tools are **off by default** and won't appear in any client's tool list until you enable them. Read [SECURITY.md](SECURITY.md) before flipping these on.

| Env var | Adds | Risk if mis-used |
|---|---|---|
| `FOUNDRY_MCP_ALLOW_WRITE=1` | World-authoring tools | Creates, updates, or deletes persistent world data |
| `FOUNDRY_MCP_ALLOW_EVAL=1` | `evaluate`, `job_result` | Arbitrary JS in your Foundry browser context; background jobs and bounded large-result retrieval |
| `FOUNDRY_MCP_ALLOW_SELF_TEST=1` | `self_test` (also requires writes) | Temporarily creates and deletes uniquely flagged test documents |
| `FOUNDRY_RELAUNCH_ENABLED=1` | `relaunch_client` | Launches a configured local Chrome and joins as the configured GM |

**One-off** (just this terminal session):

```powershell
# Windows PowerShell
$env:FOUNDRY_MCP_ALLOW_WRITE = "1"
$env:FOUNDRY_MCP_ALLOW_EVAL  = "1"
npm start
```

```bash
# macOS / Linux
FOUNDRY_MCP_ALLOW_WRITE=1 FOUNDRY_MCP_ALLOW_EVAL=1 npm start
```

**Persistent** — edit your launcher so every start picks them up:

- Windows: edit [`server/start.bat`](server/start.bat) and add `set FOUNDRY_MCP_ALLOW_WRITE=1` (and/or `set FOUNDRY_MCP_ALLOW_EVAL=1`) on a line above the `node "%~dp0server.js"` line.
- macOS/Linux: export them in your shell profile (`~/.zshrc`, `~/.bashrc`), or wrap `npm start` in your own launcher script.

After enabling, the server's startup output is the source of truth. If you set the vars but the new tools still don't appear in your AI client, it usually means the env var didn't actually reach the node process — verify with `echo %FOUNDRY_MCP_ALLOW_WRITE%` (Windows) or `echo $FOUNDRY_MCP_ALLOW_WRITE` (macOS/Linux) in the same shell *before* you launch.

Other tunables (ports, host binding, bearer token) live in the full [Environment variables](#environment-variables) table below.

### 4. Configure your AI client

Pick one or more. **All four can connect simultaneously** to the same running server.

#### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "command": "node",
      "args": ["C:\\path\\to\\foundry-mcp-live\\server\\proxy.mjs"]
    }
  }
}
```

Use the **absolute path** to `proxy.mjs`. Restart Claude Desktop.

#### Claude Code

Claude Code supports HTTP MCP natively, so no proxy is needed:

```bash
claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp
```

Confirm with `claude mcp list` — should show `foundry-vtt: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected`.

(Stdio fallback via `proxy.mjs` also works if you prefer: `claude mcp add foundry-vtt -- node /absolute/path/to/server/proxy.mjs`.)

#### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.foundry]
url = "http://127.0.0.1:3000/mcp"
```

That's the minimum. To require explicit approval for specific tools, add per-tool rules:

```toml
[mcp_servers.foundry.tools.evaluate]
approval_mode = "approve"

[mcp_servers.foundry.tools.get_actor]
approval_mode = "approve"
```

#### Gemini CLI

Project-level (recommended) — create `.gemini/settings.json` in your project root:

```json
{
  "mcpServers": {
    "foundry-mcp-server": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Or run `gemini mcp add foundry-mcp-server http://127.0.0.1:3000/mcp` from the project directory.

### 5. Connect

1. Make sure the MCP server is running (step 3).
2. Open your Foundry VTT world with the bridge module active. You should see a notification: "MCP Bridge connected to Claude Desktop".
3. Launch your AI client. The Foundry tools should appear in its tool list.

## Updating the server

The **module** updates through Foundry's normal update flow. The **server** is a
separate process and updates manually — when it's out of date, the module shows
a warning in Foundry with these same commands.

```bash
# Linux (systemd service)
cd ~/foundry-mcp-live && git pull
cd server && npm install
systemctl --user restart foundry-mcp-live

# Windows / macOS / manual
git pull                 # or re-download the latest release
cd server && npm install # required when dependencies change
# then restart the server: start.bat (Windows) or start.sh (Linux/macOS)
```

> Always run `npm install` after pulling — some fixes are dependency changes and
> won't take effect from `git pull` alone.

Full per-platform walkthrough: **[docs/updating-the-server.md](docs/updating-the-server.md)**.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_game_info` | System, world, version, connected users |
| `list_actors` | All actors (filterable by type/folder) |
| `get_actor` | Full actor data by id or name |
| `get_selected_token` | Currently selected token + actor |
| `get_active_effects` | Active Effects on a specific actor |
| `list_modules` | Installed modules (active by default) |
| `list_compendiums` | All compendium packs with metadata |
| `search_compendium` | Text search within a pack |
| `get_compendium_document` | Full document from a pack |
| `list_items` | World-level items |
| `get_item` | Full item data by id or name |
| `get_scene` | Active scene, grid, all token positions |
| `get_data_model` | System data model template |
| `list_journals` | Journal entries |
| `list_tables` | Roll tables |
| `list_macros` | Macro list with preview |
| `get_macro` | Full macro source code |
| `get_console_errors` | Recent console errors/warnings |
| `evaluate` | Run arbitrary JS in Foundry context |
| `job_result` | Poll background evaluations or read large results in chunks |
| `list_connected_bridges` | Show which Foundry users are connected (server-local tool) |
| `bridge_status` | Diagnose bridge and Foundry server availability without a live bridge |
| `relaunch_client` | Restore a dead configured GM browser session (opt-in) |
| `self_test` | Guarded Foundry schema-drift smoke test (opt-in) |

See [server/TOOLS.md](server/TOOLS.md) for full tool schemas and arguments.

## Multi-user routing

Every tool accepts an optional `targetUser` parameter. The default is the GM. To run a tool as a specific player, pass that player's exact user name:

```js
evaluate({ expression: "game.user.name", targetUser: "PlayerName" })
```

The MCP server tracks every connected Foundry user via an identity frame sent on connect (`{ type: "hello", userId, userName, isGM }`). Use `list_connected_bridges` to see who's reachable. Foundry's permission rules apply — a player-targeted call to a GM-only API will surface the same error a player would see in their own console.

Older bridges (v0.1.x) that don't send the hello frame are treated as the legacy GM, so unupgraded installs keep working.

## Debugging

From the Foundry browser console, the bridge exposes a global:

```js
mcpBridge.ws          // WebSocket instance
mcpBridge.handlers    // Handler map (callable locally for testing)
mcpBridge.errors      // Error buffer contents
mcpBridge.reconnect() // Force reconnect
```

The MCP server logs to stderr in the terminal where you started it.

To test connectivity without a client:

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

You should get a 200 with an `mcp-session-id` header.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `FOUNDRY_WS_PORT` | `3001` | WebSocket port the Foundry module connects to |
| `FOUNDRY_MCP_PORT` | `3000` | HTTP port MCP clients connect to |
| `FOUNDRY_MCP_URL` | `http://127.0.0.1:3000/mcp` | Used by `proxy.mjs` to find the HTTP server |
| `FOUNDRY_MCP_ALLOW_EVAL` | `0` | Set to `1` to enable the `evaluate` tool (arbitrary JS in Foundry context). See [SECURITY.md](SECURITY.md). |
| `FOUNDRY_URLS` | empty | Comma-separated Foundry origins for restart-safe `bridge_status` probes, e.g. `http://localhost:30000`. |
| `FOUNDRY_MCP_ALLOW_WRITE` | `0` | Set to `1` to enable world-authoring tools (`create_folder`, `create_actor`, `create_journal_entry`, etc.) that mutate persistent world data. See [SECURITY.md](SECURITY.md). |
| `FOUNDRY_MCP_ALLOW_SELF_TEST` | `0` | Set to `1` alongside `FOUNDRY_MCP_ALLOW_WRITE=1` to register the guarded `self_test` tool. |
| `FOUNDRY_MCP_USAGE` | `1` | Tool-usage telemetry — records each tool call to an in-memory aggregate (`GET /api/usage`) and a JSONL log. Set to `0`/`false`/`no`/`off` to disable. |
| `FOUNDRY_MCP_USAGE_LOG` | `server/usage-telemetry.jsonl` | Path for the per-call JSONL usage log. The log may contain truncated arg previews and `evaluate` bodies, so keep it local. |
| `FOUNDRY_RELAUNCH_ENABLED` | `0` | Register `relaunch_client`. Requires the URL, GM user, and Chrome path variables below. |
| `FOUNDRY_RELAUNCH_URL` | empty | Explicit Foundry origin to rejoin, e.g. `http://localhost:30000`. Loopback-only unless remote use is explicitly allowed. |
| `FOUNDRY_RELAUNCH_GM_USER` | empty | Exact Foundry GM user name selected on the join page. |
| `FOUNDRY_RELAUNCH_GM_PASSWORD` | empty | Optional GM password. Read only from the server environment; never accepted as a tool argument or returned. |
| `FOUNDRY_CHROME_PATH` | empty | Absolute path to the Chrome/Chromium executable used by `puppeteer-core`. |
| `FOUNDRY_CHROME_USER_DATA_DIR` | empty | Optional dedicated Chrome profile directory for the relaunched client. |
| `FOUNDRY_RELAUNCH_ALLOW_REMOTE` | `0` | Set to `1` to allow a non-loopback `FOUNDRY_RELAUNCH_URL`. |
| `FOUNDRY_WS_HOST` | `127.0.0.1` | Interface the bridge WebSocket binds to. Default is loopback. Set `0.0.0.0` to let another device on your LAN connect — see [Connecting a second device](#connecting-a-second-device-on-your-lan). |
| `FOUNDRY_WS_TOKEN` | (auto-generated when needed) | Shared secret for the **WebSocket bridge only**, required of clients that reach the bridge **from another machine**. A Foundry client on the server's own machine connects without one. You normally don't set this: when the bridge is exposed with `FOUNDRY_WS_HOST`, the server generates a token, saves it to `bridge-token` in its config dir, and a local GM client publishes it into the world so other devices pick it up automatically. Set it explicitly only to choose the value yourself. |
| `FOUNDRY_WS_ALLOWED_ORIGINS` | (unset) | Extra browser origins that may connect from this machine without a token, comma-separated (`http://foundry.lan:30000`). Loopback origins are already allowed; you need this only when the local client is served under a non-loopback name, e.g. through an SSH tunnel or a hosts-file alias. |
| `BRIDGE_TOKEN` | (unset) | Shared secret for **both** the bridge and the MCP HTTP endpoint. If set, all MCP HTTP requests must send `Authorization: Bearer <token>`. See [SECURITY.md](SECURITY.md). |

## Connecting a second device on your LAN

By default the bridge only works for a browser on the same machine as the MCP server. Everything else is the same as a local setup; two things have to change.

**Why.** The module dials the MCP server over a WebSocket, and the server runs on exactly one machine. On a second device, "localhost" is that device — not the machine running the server. So the module resolves its target from the page host instead:

| Foundry is at | Module dials | Because |
|---|---|---|
| `localhost:30000` | `ws://localhost:3001` | Server is on this same box |
| `192.168.0.106:30000` | `ws://192.168.0.106:3001` | Server is on the Foundry box |
| `https://your-world.example.com` | `ws://localhost:3001` | A hosted Foundry doesn't run your MCP server — you do |

Override it per-browser with the **MCP server address** module setting (client-scoped, so each device sets its own). Accepts `192.168.0.106`, `192.168.0.106:3001`, or a full `ws://host:port`; port 3001 is assumed if omitted. Leave it blank to use the table above.

**1. Expose the bridge port.** In `~/.config/foundry-mcp-live/server.env`:

```sh
FOUNDRY_WS_HOST=::
FOUNDRY_WS_TOKEN=<paste output of: openssl rand -hex 24>
```

Use `::`, not `0.0.0.0`. `0.0.0.0` is IPv4-only, so a browser that resolves `localhost` to `::1` finds nothing listening and fails with a bare "can't establish a connection" — while every check you run from a shell passes, because command-line clients fall back to IPv4 and browsers may not. `::` binds IPv6 and still accepts IPv4 through v4-mapped addresses, so `localhost`, `127.0.0.1`, `[::1]` and the LAN IP all work regardless of what the browser's resolver prefers.

Then `systemctl --user restart foundry-mcp-live`. The MCP HTTP port (3000) stays bound to `127.0.0.1` either way — only the bridge is exposed.

**Then open the port in your host firewall**, which is a separate thing from the bind address and easy to miss: the server will happily report `listening on ws://0.0.0.0:3001` while the firewall silently drops every packet from the other device. The failure looks identical to "the client isn't trying" — nothing in the server log at all, not even a rejection.

```sh
# ufw — scope it to your LAN, not the internet
sudo ufw allow from 192.168.0.0/24 to any port 3001 proto tcp comment 'Foundry MCP bridge'

# firewalld
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.0.0/24 port port=3001 protocol=tcp accept'
sudo firewall-cmd --reload
```

Verify from the *other* device, not from the server — testing a host's own LAN IP from that same host doesn't traverse the firewall and will pass even when a real remote connection would be dropped. Browsing to `http://<server-ip>:3001` from the laptop is enough: a reachable bridge answers a plain HTTP request with an error page or an immediate close, whereas a blocked port hangs or refuses.

**2. Tell the world the token, once.** As GM, open **Module Settings → Foundry MCP Live → MCP bridge token** and paste the same value. It's world-scoped, so Foundry hands it to every client that loads the world — the laptop, a tablet, a player's PC — with no per-device setup.

Without a matching token the server closes the socket with code 1008 and the module raises a notification saying so (pointing the GM at the setting, and players at their GM).

Clients can still override with `localStorage.setItem("mcpBridgeToken", "…")` in the browser console — useful when one client needs a different token than its world advertises. The world setting wins when both are set, so a stale hand-set value can't lock a client out of a world whose token has since been corrected.

`FOUNDRY_WS_TOKEN` deliberately covers only the WebSocket half. `BRIDGE_TOKEN` also puts Bearer auth on `/mcp`, which breaks any MCP client that can't send a header — Codex has no per-server header config and would need `server/proxy.mjs` with `BRIDGE_TOKEN` in its env. Since `/mcp` is loopback-only anyway, the bridge-only token is the right tool for this job.

**Don't skip the token.** With `FOUNDRY_WS_HOST=0.0.0.0` and no token, anything that can route to port 3001 can register as a GM bridge and drive your world — including the `evaluate` and world-authoring tools if those env gates are on. The server logs a warning at startup when it's bound off-loopback without one.

## Notes

- The WebSocket connection auto-reconnects every 5 seconds if Foundry is reloaded. The hello frame is re-sent each time.
- Console error capture starts when the module loads — errors before the `ready` hook are missed.
- The `evaluate` tool runs arbitrary JS in the Foundry client context — disabled by default. Enable with `FOUNDRY_MCP_ALLOW_EVAL=1`. Use `background: true` plus `job_result` for unbounded work; results larger than 256 KiB are returned by handle.
- World-authoring tools (create actors/folders/journals) also mutate persistent state and are disabled by default. Enable with `FOUNDRY_MCP_ALLOW_WRITE=1`. See [SECURITY.md](SECURITY.md).
- `relaunch_client` is local and opt-in. Keep its Chrome profile dedicated to Foundry automation and store any GM password only in the server environment.
- Both ports bind to `127.0.0.1` only — not exposed to the network.
- No API tokens are consumed by the AI clients. All communication is local: AI client ↔ MCP server ↔ Foundry browser.
- Tool-usage telemetry is on by default and fully local. `GET /api/usage` returns the live per-tool aggregate (counts, error rate, avg duration, first/last used); the JSONL log records one rich line per call for offline analysis. Both are gated by the same `BRIDGE_TOKEN` as `/mcp` when one is set. Disable with `FOUNDRY_MCP_USAGE=0`.
- See [SECURITY.md](SECURITY.md) for the threat model and opt-in auth.

## Testing

```bash
cd server
npm test      # unit suite (node --test), no Foundry needed
npm run e2e   # end-to-end against a real Foundry
```

`npm run e2e` stands up a **second** Foundry from your existing install — its
own port (30002), its own data directory, and a throwaway fixture world — then
joins it in a real browser and drives a tool call through the whole chain:
MCP → bridge → game API. It fails on any console error naming this module,
which is the class of breakage that does not throw and so survives a mocked
test suite.

It reuses the licence you already activated; there is no second key, no
credentials, and no container involved. Your running game is untouched —
different port, different dataPath, different world. The MCP server does need
to be running, since the bridge is what is under test.

| Env | |
|---|---|
| `FOUNDRY_APP` | Foundry's app dir, if not `~/FoundryV14/app` |
| `FOUNDRY_E2E_PORT` | port for the throwaway instance (default 30002) |
| `FOUNDRY_CHROME_PATH` | browser binary (default `/usr/bin/chromium`) |
| `E2E_KEEP=1` | leave it running afterwards to poke at it |

## Releasing a new version

1. Bump `version` in [module/module.json](module/module.json) and [server/package.json](server/package.json), and refresh both root `version` fields in `server/package-lock.json` (top level and `packages[""]`). `server.js` needs no edit — `SERVER_VERSION` is read from `package.json` at startup. Move the `## [Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a dated `## [x.y.z]` heading.
2. Commit, then tag and push: `git tag v0.5.2 && git push --tags`.
3. The [release workflow](.github/workflows/release.yml) builds `module.zip` and publishes a GitHub Release with `module.json` + `module.zip` attached. The manifest URL `releases/latest/download/module.json` then points at the new version automatically, so Foundry's update check picks it up.

## License

[MIT](LICENSE) © DimitroffVodka
