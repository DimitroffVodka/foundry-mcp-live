# Installation & Setup

[← Wiki home](Home)

Three pieces have to be in place before an agent can read a world: the Foundry
module, the MCP server, and a client pointed at that server. This page installs
all three in order and then proves the chain works.

## What you need

| Requirement | Detail |
|---|---|
| Foundry VTT | **v13 or v14**. `module/module.json` declares `"minimum": "13"`, `"verified": "14"` |
| Node.js | What CI tests is **22 and 24**; `server/package.json` declares no engine range, so older versions are untested rather than supported |
| An MCP client | Claude Desktop, Claude Code, Codex CLI, Gemini CLI — all four can be connected at once |
| A world you can open | The module connects on **world load**, not on the setup/join screen |

## 1. Clone and install

```bash
git clone https://github.com/DimitroffVodka/foundry-mcp-live.git
cd foundry-mcp-live/server
npm install
```

## 2. Install the Foundry module

In Foundry: **Add-on Modules → Install Module → Manifest URL**, and paste:

```
https://github.com/DimitroffVodka/foundry-mcp-live/releases/latest/download/module.json
```

Then enable **Foundry MCP Live** in the world's **Manage Modules** list.

<details>
<summary>Manual install, or a dev copy</summary>

Copy or symlink the repo's `module/` folder into Foundry's modules directory as
`foundry-mcp-live`:

- **Windows:** `%localappdata%\FoundryVTT\Data\modules\foundry-mcp-live`
- **Linux:** `/home/foundry/foundrydata/Data/modules/foundry-mcp-live`
- **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/foundry-mcp-live`

Or let the deploy script stage and verify it:

```bash
node scripts/deploy-module.mjs /path/to/Data/modules/foundry-mcp-live --dev
```

`--dev` strips the manifest/download URLs and suffixes the version with
`-dev.<timestamp>`, so Foundry's updater leaves that copy alone. After changing
anything under `module/`, run `node scripts/stamp-module.mjs` and commit
`module/scripts/build-info.js` — CI fails when the stamp is stale, and
`bridge_status` reports `moduleStale: true` for a client whose files differ from
the server's.

</details>

## 3. Start the server

Keep it running for the whole session:

```bash
cd server
npm start
```

`npm start` is `node server.js` with no gates flipped. On a successful start you
should see both halves:

```
WebSocket bridge listening on ws://127.0.0.1:3001
MCP HTTP server  listening on http://127.0.0.1:3000/mcp
```

> **`server/start.sh` is not `npm start`.** That launcher exports
> `FOUNDRY_MCP_ALLOW_WRITE=1` and `FOUNDRY_MCP_ALLOW_EVAL=1` before starting, so
> it turns world authoring **on**. Use it only if that is what you want; use
> `npm start` for the documented default (writes off). Windows'
> `server/start.bat` keeps writes off. See [Settings Reference](Settings-Reference).

### Optional: run it as a user service

```bash
./scripts/install-linux-user-service.sh
```

That creates `~/.config/systemd/user/foundry-mcp-live.service` and an optional
env file at `~/.config/foundry-mcp-live/server.env` (ports, gates, token,
relaunch settings). The service keeps the safe defaults: write, self-test,
relaunch and relay are off until you add the matching variables, while
`evaluate` stays on (the default) unless you set `FOUNDRY_MCP_ALLOW_EVAL=0`.

```bash
systemctl --user status foundry-mcp-live.service
journalctl --user -u foundry-mcp-live.service -f
systemctl --user restart foundry-mcp-live.service
```

User services start at login. To start before login, enable lingering once:
`sudo loginctl enable-linger "$USER"`.

## 4. Connect a client

| Client | Transport | Configuration |
|---|---|---|
| Claude Desktop | stdio → `proxy.mjs` | `claude_desktop_config.json` (below) |
| Claude Code | native HTTP | `claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp` |
| Codex CLI | native HTTP | `~/.codex/config.toml` (below) |
| Gemini CLI | native HTTP | project `.gemini/settings.json` (below) |

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

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

Use the **absolute** path, then restart Claude Desktop.

**Claude Code** — the HTTP command above, confirmed with `claude mcp list`.
Or install the plugin, which adds the connection **and** three skills:

```
/plugin marketplace add DimitroffVodka/foundry-mcp-live
/plugin install foundry-mcp-live@foundry-mcp-live
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.foundry]
url = "http://127.0.0.1:3000/mcp"
```

**Gemini CLI** — `.gemini/settings.json` in the project root, or
`gemini mcp add foundry-mcp-server http://127.0.0.1:3000/mcp`:

```json
{
  "mcpServers": {
    "foundry-mcp-server": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## 5. Verify the chain

Do these in order. If the first one fails, nothing else can work.

1. **`list_connected_bridges`** — non-empty means Foundry is reachable. Note each
   entry's `targetUser` and `isGM`.
2. **`get_game_info`** — Foundry version, system, world and active users.
3. **`list { "type": "actor" }`** — proves a routed call reaches the world.
4. **`scene_read`** — proves scene reads work.

If **several bridges** are connected (a local world and a hosted one, say), pick
one and pass its `targetUser` on every later call. Both may be GM, and the
default route may not be the world you meant. With one bridge, omitting
`targetUser` is fine.

## A second device on the LAN

By default only a browser on the server's machine can connect. To drive Foundry
from a laptop or tablet:

1. On the server, set `FOUNDRY_WS_HOST=::` in
   `~/.config/foundry-mcp-live/server.env` and restart the service. Use `::`, not
   `0.0.0.0` — the latter is IPv4-only and fails for browsers that resolve
   `localhost` to `::1`.
2. With the bridge off-loopback and no token configured, the server generates
   one and saves it to `bridge-token` in its config dir, and a local GM client
   publishes it into the world. To choose the value yourself, set
   `FOUNDRY_WS_TOKEN=<openssl rand -hex 24>`.
3. **Open port 3001 in the host firewall** — a separate step from the bind
   address, and easy to miss: the log can say `listening on ws://…:3001` while
   the firewall drops every packet.
4. As GM, paste the same token into **Configure Settings → Foundry MCP Live →
   MCP bridge token**. It is world-scoped, so every client that loads the world
   gets it with no per-device setup.

If a client needs a different token than its world advertises,
`localStorage.setItem("mcpBridgeToken", "…")` in the browser console is honoured
— but the world setting wins when both are set.

`FOUNDRY_WS_TOKEN` gates only the WebSocket. `BRIDGE_TOKEN` also puts Bearer auth
on `/mcp`, which breaks any client that cannot send a header (Codex has no
per-server header config; it would need `proxy.mjs` with the token in its env).
Since `/mcp` is loopback-only anyway, the bridge-only token is the right knob for
the LAN case.

## When it will not connect

| Symptom | Cause | Fix |
|---|---|---|
| `FML-0001` — no GM bridge connected | No Foundry tab is connected as GM | Open the world as GM, enable the module, check the server log for `bridge connected`, reload the tab |
| `FML-0002` — no bridge for `targetUser` | The name does not match a connected user | Call `list_connected_bridges`; use `userName`, `userName@host`, or the raw user id |
| `FML-0003` — write tool refused | `FOUNDRY_MCP_ALLOW_WRITE` is unset, or the world setting is off | Set the env gate and restart; check **Allow AI to modify the world** |
| `FML-0004` — invalid bearer token | `BRIDGE_TOKEN` is set and the header is missing or wrong | Send `Authorization: Bearer …`, or unset `BRIDGE_TOKEN` on a single-user machine |
| `FML-0005` — relaunch misconfigured | `relaunch_client` called without a valid relaunch config | Needs `FOUNDRY_RELAUNCH_ENABLED=1`, `FOUNDRY_CHROME_PATH`, `FOUNDRY_RELAUNCH_GM_USER`, a loopback `FOUNDRY_RELAUNCH_URL` |
| Tools never appear in the client | The server is not running, or the client points at the wrong URL | Check the two startup lines, then the client's URL and `FOUNDRY_MCP_URL` |
| World loads silently, no bridge | **Auto-connect to MCP server** is off on this client | Turn the setting on, or run `mcpBridge.reconnect()` in the browser console |

Full text for each code lives in the
[error catalogue](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/docs/errors.md).
