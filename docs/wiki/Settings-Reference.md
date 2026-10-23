# Settings Reference

[← Wiki home](Home)

There are two layers of configuration and they gate different things:

| Layer | Set where | Applies | Restart to change |
|---|---|---|---|
| **Foundry module settings** | In Foundry: **Configure Settings → Foundry MCP Live** | That world, or that browser (per-client settings) | No — live |
| **Server environment variables** | The shell that starts the server, `server/start.bat`, or `~/.config/foundry-mcp-live/server.env` | The whole server process | Yes — read once at startup |

A write has to pass **both**: the server must have registered the tool, and the
world setting must permit the call. Turning one on does not turn the other on.

---

## Module settings

Six are visible in Configure Settings; one is machine data and hidden. Source:
`module/scripts/bridge.js`.

### Allow AI to modify the world

| | |
|---|---|
| Key | `foundry-mcp-live.allowWorldMutations` |
| Scope | World — GM only |
| Default | **On** |
| Type | Boolean |

The master read-only switch for the bridge, changeable without touching the
server. When **off**, every handler classified `write` or `delete` in
`module/lib/handler-access.js` is refused by `dispatch()` — that is a wider set
than "world authoring": it includes `roll`, `draw_table`, `use_item`, token
moves and targeting, `click` and dialog simulation, `chat` send, `request`,
`evaluate`, `call_module_api` and `changes` undo. Read-only means the AI changes
nothing.

It **fails closed**: if the setting cannot be read at all, writes stay refused
until it can. It also sits *inside* the server's env ceiling — creating or
deleting persistent content still needs `FOUNDRY_MCP_ALLOW_WRITE=1` on the
server, which the AI cannot change.

### Auto-connect to MCP server

| | |
|---|---|
| Key | `foundry-mcp-live.autoConnect` |
| Scope | Client — each browser |
| Default | **On** |
| Type | Boolean |

When on, this browser dials the bridge as soon as the world loads, and retries
every 5 s while disconnected. Turn it off on a play-only client that should not
carry a bridge socket; connect on demand from the console with
`mcpBridge.reconnect()`.

A headless client — `game.settings.get("core", "noCanvas")`, the dedicated
bridge browser — **always** auto-connects regardless of this setting, so the
tools stay available even when every interactive client has opted out.

### MCP bridge token

| | |
|---|---|
| Key | `foundry-mcp-live.bridgeToken` |
| Scope | World — GM only |
| Default | Empty |
| Type | String |

Leave blank unless the server sets `FOUNDRY_WS_TOKEN` or `BRIDGE_TOKEN` — in
practice, unless you opened the bridge to the LAN. World-scoped on purpose:
Foundry hands world settings to every client that loads the world, so the GM
pastes the secret once and no device needs devtools. Changing it closes every
client's socket so the next attempt re-handshakes.

A client-side `localStorage.mcpBridgeToken` is honoured where this is blank; the
world setting wins when both are set, so a stale hand-set value cannot lock a
client out of a corrected world.

On a hosted world (The Forge, a VPS) this is the one extra step setup needs: the
page's origin is public, so the server enforces the token for that loopback
peer. See [Hosting & Networking](Hosting-and-Networking).

### MCP server address

| | |
|---|---|
| Key | `foundry-mcp-live.bridgeUrl` |
| Scope | Client — each browser |
| Default | Empty (derive from the page host) |
| Type | String |

Blank means the module resolves the bridge from the page host: `localhost:30000`
→ `ws://localhost:3001`, `192.168.0.106:30000` → `ws://192.168.0.106:3001`, and a
hosted `https://` world → `ws://localhost:3001` (because the MCP server runs on
your machine, not the host's). Set it for a second device whose own "localhost"
is not the server — `192.168.0.106`, `192.168.0.106:3001`, or a full
`ws://host:port`; port 3001 is assumed when omitted. Changing it repoints the
socket without a world reload.

### Allow `evaluate` over the relay

| | |
|---|---|
| Key | `foundry-mcp-live.relayAllowEvaluate` |
| Scope | World — GM only |
| Default | **Off** |
| Type | Boolean |

In a relay, the receiving browser is the security boundary, not the MCP server:
a relayed packet reaches a handler without passing the server's
`FOUNDRY_MCP_ALLOW_EVAL` gate. Off means a remote client's relayed `evaluate`
is refused even when the server allows evaluation, and relayed writes that would
**store a script** are refused too — Region script/macro behaviours, script
macros, Monk's Active Tiles actions, Mass Edit spawn scripts, Item Piles macros.
Turn it on only if you trust every GM-capable user in the world.

### Announce relay status on world load

| | |
|---|---|
| Key | `foundry-mcp-live.relayAnnounce` |
| Scope | Client — each browser |
| Default | **On** |
| Type | Boolean |

Shows a once-per-session notice saying how the MCP server can reach this browser:
a notice naming the relay device, or a warning when this browser is relay-only
and no gateway exists yet. Nothing is shown when the direct bridge is already
connected. Turn it off for completely silent world loads; the relay keeps
working either way.

### `relayGatewayKeys` (hidden)

| | |
|---|---|
| Key | `foundry-mcp-live.relayGatewayKeys` |
| Scope | World |
| Default | Empty |
| Visible in settings | **No** (`config: false`) |

Public keys for the Foundry-mediated relay, published by the MCP server's gateway
browser. World-scoped because Foundry only lets GMs *write* world settings, which
is what makes the channel trustworthy; every client may read the keys. Rotated on
each MCP server restart, so the cached key is dropped when this changes.

---

## Environment variables

Read once when `server/server.js` starts. Change one → restart the server
(`systemctl --user restart foundry-mcp-live` for the user service).

### Ports and binding

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_MCP_PORT` | `3000` | HTTP port for `/mcp`. Bound to `127.0.0.1` only, always |
| `FOUNDRY_WS_PORT` | `3001` | WebSocket port the Foundry module dials |
| `FOUNDRY_WS_HOST` | `127.0.0.1` | Bridge bind address. `::` to let another LAN device connect (IPv6 + v4-mapped; prefer it to `0.0.0.0`) |
| `FOUNDRY_WS_ALLOWED_ORIGINS` | unset | Extra browser origins allowed to connect from this machine without a token, comma-separated. Only needed for a non-loopback name that still reaches the bridge over loopback (SSH tunnel, hosts alias) |
| `FOUNDRY_URLS` | empty | Comma-separated Foundry origins used for restart-safe `bridge_status` probes, and added to the trusted-origin list |
| `FOUNDRY_MCP_URL` | `http://127.0.0.1:3000/mcp` | Where `proxy.mjs` (and the Claude Code plugin's `.mcp.json`) look for the server |

### Capability gates

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_MCP_ALLOW_WRITE` | `0` | `1` registers the world-authoring tools. Off by design: a default install cannot be talked into mutating a world |
| `FOUNDRY_MCP_ALLOW_EVAL` | `1` | **On by default.** `0`/`false`/`no`/`off` drops `evaluate` and `job_result` |
| `FOUNDRY_MCP_ALLOW_SELF_TEST` | `0` | `1`, together with `ALLOW_WRITE=1`, registers the guarded `self_test` |

With the write gate off, most write tools are not merely refused — they are
never registered, so they do not appear in the client's tool list at all. `chat`
is the exception: it registers either way because `action: "read"` is a read, and
only `action: "send"` raises `FML-0003`.

Counted against a running server, the tool list grows in steps: **27** with no
gates, **34** with `FOUNDRY_MCP_ALLOW_WRITE=1`, **38** with the write gate plus
the design harness (`render_fixture`, `preview_fixture`, `write_variant`,
`ui_test`), and **40** with `self_test` and `relaunch_client` as well.
`FOUNDRY_MCP_ALLOW_EVAL=0` removes two (`evaluate`, `job_result`).

### Auth

| Var | Default | Purpose |
|---|---|---|
| `BRIDGE_TOKEN` | unset | Shared secret for **both** `/mcp` and the bridge. When set, `/mcp` and `/api/usage` require `Authorization: Bearer …` |
| `FOUNDRY_WS_TOKEN` | auto | Secret for the **WebSocket only**. Defaults to `BRIDGE_TOKEN`. When the bridge is exposed off-loopback and nothing is configured, the server generates one and persists it to `bridge-token` in its config dir |

`FOUNDRY_WS_TOKEN` exists because the two endpoints have different exposure:
`/mcp` is hard-bound to loopback, while the bridge is the half you open to the
LAN. Gating both on `BRIDGE_TOKEN` would break every loopback client that cannot
send a header.

### Telemetry

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_MCP_USAGE` | `1` | Per-call usage telemetry: in-memory aggregate at `GET /api/usage` plus a JSONL log. `0`/`false`/`no`/`off` disables |
| `FOUNDRY_MCP_USAGE_LOG` | `server/usage-telemetry.jsonl` | JSONL path. It can contain truncated arg previews and `evaluate` bodies — keep it local |

### GM client relaunch (`relaunch_client`)

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_RELAUNCH_ENABLED` | `0` | Registers `relaunch_client` |
| `FOUNDRY_RELAUNCH_URL` | empty | Foundry origin to rejoin. Loopback unless remote is allowed |
| `FOUNDRY_RELAUNCH_GM_USER` | empty | Exact GM user name on the join page |
| `FOUNDRY_RELAUNCH_GM_PASSWORD` | empty | Optional GM password. Server env only — never a tool argument, never returned |
| `FOUNDRY_CHROME_PATH` | empty | Absolute path to Chrome/Chromium for `puppeteer-core` |
| `FOUNDRY_CHROME_USER_DATA_DIR` | empty | Optional dedicated Chrome profile |
| `FOUNDRY_RELAUNCH_ALLOW_REMOTE` | `0` | `1` allows a non-loopback relaunch URL |
| `FOUNDRY_RELAUNCH_HEADLESS` | `0` | `1` runs the recovery client headless; the canvas and CSS animations are disabled to keep software WebGL off the CPU |
| `FOUNDRY_RELAUNCH_AUTO` | `0` | `1` makes the server watch for the configured GM bridge dropping and relaunch automatically |
| `FOUNDRY_RELAUNCH_AUTO_INTERVAL_MS` | `15000` | Watch interval |
| `FOUNDRY_RELAUNCH_AUTO_MAX_BACKOFF_MS` | `300000` | Backoff ceiling between attempts |

Required set for `relaunch_client` to validate: `FOUNDRY_RELAUNCH_ENABLED=1`,
`FOUNDRY_CHROME_PATH`, `FOUNDRY_RELAUNCH_GM_USER`, and a valid
`FOUNDRY_RELAUNCH_URL`. Otherwise the tool answers `FML-0005` and names every
failing field at once.

### Relay gateway

A managed Chromium that joins Foundry as an ordinary client and relays tool calls
to browsers the server cannot reach directly — a phone, a tablet, a Steam Deck, a
hosted world. Off by default because it launches a real browser.

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_RELAY_ENABLED` | `0` | Starts the gateway |
| `FOUNDRY_RELAY_URL` | falls back to `FOUNDRY_RELAUNCH_URL` | Foundry origin the gateway joins |
| `FOUNDRY_RELAY_GM_USER` | falls back to `FOUNDRY_RELAUNCH_GM_USER` | Must be GM-capable: publishing the gateway keys writes a world setting |
| `FOUNDRY_RELAY_GM_PASSWORD` | falls back to `FOUNDRY_RELAUNCH_GM_PASSWORD` | Optional |
| `FOUNDRY_RELAY_USER_DATA_DIR` | empty | Gateway's own Chrome profile |
| `FOUNDRY_RELAY_HEADLESS` | `1` | Headless unless set to `0`/`false`/`no` |

### Other

| Var | Default | Purpose |
|---|---|---|
| `FOUNDRY_MCP_GALLERY_DIR` | `~/.cache/foundry-mcp/design-gallery` | Where the design-fixture harness stores its gallery (only relevant when a harness is installed) |
| `FOUNDRY_MCP_TOKEN` | unset | **Client-side only**: the Claude Code plugin sends it as the Bearer token. Not read by the server |

---

## Where a refused call actually stops

1. **Tool not in the list** — the server did not register it:
   `FOUNDRY_MCP_ALLOW_WRITE` is unset (or `FOUNDRY_MCP_ALLOW_EVAL=0` for
   `evaluate`). Fix the server env and restart.
2. **Tool present but refused** — `allowWorldMutations` is off in the world, or
   the setting could not be read. Fix it in Configure Settings; no restart.
3. **Tool ran but the change is unwanted** — `changes` with `action: "undo"` can
   reverse a call, deletes included, while the entry is still in the routed
   browser's change log (the last 200 entries). Foundry itself has no undo.

See the [error catalogue](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/docs/errors.md)
for the exact text of `FML-0001` … `FML-0005`, and
[SECURITY.md](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/SECURITY.md)
for the threat model behind each gate.
