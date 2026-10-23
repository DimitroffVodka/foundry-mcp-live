# Hosting & Networking

[← Wiki home](Home)

**The AI side is local. The Foundry side does not have to be.**

The MCP server runs on the machine you are sitting at — the same machine as the
browser tab that has the world open. The Foundry *server* can be on that machine,
on another box in the house, or hosted on The Forge or a VPS. What matters is the
direction of the connection: **the Foundry tab dials out to the MCP server; the
server never dials Foundry.**

```
        your machine                                 anywhere
┌──────────────────────────────┐
│  Foundry tab (browser)       │
│        │  ws://localhost:3001│──► MCP server (HTTP :3000, WS :3001)
│        ▼                     │            ▲
│  module executes tool calls  │            │ HTTP
└──────────────────────────────┘      AI client
        │
        └── HTTPS ──► hosted Foundry (The Forge, a VPS, your LAN server)
```

Two consequences worth internalising:

- **Closing the tab disconnects the bridge.** The module lives in the client, not
  on the Foundry host. A hosted world can be "running" with no one in it and
  still be unreachable — because no browser is executing the module.
- **Foundry's hostname never enters the socket path.** A Forge world is still
  reached over `ws://localhost:3001`, because the server is on *your* machine,
  not on the Forge box.

---

## Which setup are you?

| Foundry runs on | MCP server + AI run on | What to configure |
|---|---|---|
| This machine | This machine | Nothing. `localhost` is correct |
| Another machine on the LAN | This machine (browser and server together) | Nothing. The server follows the **browser**, not Foundry |
| **The Forge / a hosted world** | This machine | Address blank → `ws://localhost:3001`. If the server has a bridge token, paste it into the world setting |
| This machine or hosted | **A different** machine | Point the module's **MCP server address** at that machine, expose the bridge, set a token — and use `wss://` if the page is https |
| Hosted world, extra devices (tablet, player PC) | This machine | A direct socket to a private IP is blocked from an https page — use the **relay gateway** |

---

## Setting up on The Forge

The Forge hosts Foundry; it does not host this server. Your browser still runs
the module, and the module still dials your machine.

1. **Start the MCP server locally**, on the same machine as your browser:

   ```bash
   cd server
   npm start
   ```

   Leave it on the default loopback bind. Nothing needs to be exposed for this
   case — no firewall rule, no port forward, no token, no LAN address.

2. **Install the module into the Forge world.** In the Forge's Foundry setup
   screen, install from the manifest URL (the same one as a local install), or
   from the Bazaar if the package is listed:

   ```
   https://github.com/DimitroffVodka/foundry-mcp-live/releases/latest/download/module.json
   ```

   The Forge installs packages server-side; the module files end up in that
   world. Enable **Foundry MCP Live** in the world's **Manage Modules**.

3. **Open the world in your browser as GM.** The module derives its target from
   the page host: a public origin (anything that is not loopback, `.local`,
   `.lan`, `.internal`, or an RFC1918 address) resolves to `ws://localhost:3001`.
   That is deliberate — a hosted Foundry is not running the server; you are.

4. **If the server has a bridge token, paste it once.** `FOUNDRY_WS_TOKEN` (or
   `BRIDGE_TOKEN`) set on the server means the hello frame must carry it. Open
   **Configure Settings → Foundry MCP Live → MCP bridge token** and paste the
   same value. It is world-scoped, so the Forge hands it to every client that
   loads the world.

   This is the step people miss on a hosted world. The socket does arrive on
   loopback, but it carries `Origin: https://<world>.forge-vtt.com`, so the
   server does **not** treat it as a trusted local peer and enforces the token
   (`server/lib/bridges.js`, `isTrustedLocalPeer` + `tokenRequired`). With no
   token configured, the default loopback trust applies and nothing needs
   pasting.

   The alternative to pasting: add the world's origin to `FOUNDRY_URLS` or
   `FOUNDRY_WS_ALLOWED_ORIGINS` on the server, which allowlists it as a trusted
   local origin. `FOUNDRY_URLS` also gives `bridge_status` a URL to probe.

5. **Verify the chain.** `list_connected_bridges` should show you, with
   `host` set to the Forge world's host. `get_game_info` then confirms the world,
   system and version.

### What you do not need on The Forge

- No `FOUNDRY_WS_HOST` change, no token, no firewall rule — as long as the AI
  and the browser are on the same machine.
- No relay, unless extra devices need to reach the same server (below).
- No change to the **MCP server address** setting; blank is correct.

### What you cannot do

- **Run the MCP server on the Forge.** It needs a Node process and a browser
  that can reach it; the Forge gives you a Foundry instance, not a shell.
- **Make the server connect to Foundry.** There is no outbound connection to
  Foundry in the server; the module is the client.

---

## Why the address rules are what they are

`module/scripts/bridge-url.js` derives the default in one place:

| Page host | Dialled address | Because |
|---|---|---|
| `localhost:30000` | `ws://localhost:3001` | Server is on this box |
| `192.168.0.106:30000` | `ws://192.168.0.106:3001` | Server is on the Foundry box |
| `https://world.forge-vtt.com` | `ws://localhost:3001` | Server is on the **viewer's** box |

An explicit **MCP server address** overrides it, and accepts `host`,
`host:port`, `ws://host:port`, or `wss://host` (TLS on 443 — a reverse proxy,
Tailscale Serve, or a tunnel). That last form exists because a plain `ws://`
bridge has no TLS of its own.

## Why a hosted page cannot always reach a bridge on another machine

A browser will not let an https page open `ws://` to a private IP — mixed
content, blocked as a `SecurityError` before any packet is sent. `localhost` is
the exception: browsers treat loopback as a trustworthy origin, which is what
makes the Forge case work at all. This is exactly why the relay exists
(`module/scripts/relay.js` says so in its header): a device that can never be a
direct network peer of the server still holds an authenticated TLS socket to
Foundry, so the server routes through that instead.

Browsers are also tightening public-page access to local devices (Chrome's Local
Network Access permission). If your browser prompts when the world loads, allow
it. If it blocks the socket instead, the console shows a connection error rather
than the usual "MCP Bridge connected" notice — use the relay.

> Source-grounded, not Forge-verified: the connection rules above come from this
> repository and were exercised against a local Foundry. The Forge path has not
> been run end-to-end here; if the console shows a CSP refusal rather than a
> connection error, treat it as a new finding and report it.

---

## Extra devices: the relay gateway

Use this when the browser that needs the bridge is **not** on the server's
machine and cannot be: a tablet on a hosted world, a player's PC, a phone. The
relay does not open a port. It puts one managed Chromium on the server's machine
into the world as a GM client and routes requests through Foundry's own module
socket, which every client already has.

```sh
# ~/.config/foundry-mcp-live/server.env
FOUNDRY_RELAY_ENABLED=1
FOUNDRY_RELAY_URL=https://world.forge-vtt.com
FOUNDRY_RELAY_GM_USER=Gamemaster
FOUNDRY_RELAY_GM_PASSWORD=...          # falls back to FOUNDRY_RELAUNCH_*
FOUNDRY_CHROME_PATH=/usr/bin/chromium
FOUNDRY_RELAY_USER_DATA_DIR=~/.local/share/foundry-mcp-live/relay-profile
# FOUNDRY_RELAY_HEADLESS=0             # headless by default; 0 to watch it work
```

- The gateway logs in through Foundry's **/join** form with the configured user
  and password. It must be GM-capable: publishing the gateway keys writes a
  world setting, and Foundry only lets GMs write those.
- A Chromium profile that is already signed in (`FOUNDRY_RELAY_USER_DATA_DIR`)
  is the safer path when the account uses MFA or a bot check that an unattended
  login cannot complete.
- The gateway mints a keypair on every server restart and republishes it; clients
  drop their cached key when the world setting changes.
- Relayed `evaluate` and relayed script-storing writes stay refused unless
  **Allow `evaluate` over the relay** is turned on. Leave it off unless you trust
  every GM-capable user in the world.
- Every client that should be reachable needs module 1.0.0 or newer — older
  clients have no relay code.

Relay status is announced once per session on a client that is relay-only; the
**Announce relay status on world load** setting silences it.

## If the AI runs on another machine

Possible, but it costs three settings and one network decision:

1. On the server machine: `FOUNDRY_WS_HOST=::` (and a firewall rule for 3001).
2. Set `FOUNDRY_WS_TOKEN` and paste the same value into the world's **MCP bridge
   token**. Anything reachable off-loopback without a token is a GM bridge to
   anyone who can route to the port.
3. In the module on the browser side: **MCP server address** = the server's
   LAN address, or a `wss://` URL if the page is https.

If the browser is on a hosted https world, remember that `ws://` to a private IP
is blocked — that case needs a TLS front (reverse proxy, Tailscale Serve,
Cloudflare Tunnel) or the relay.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `1008 auth failed`, permanent red notification | Server has a bridge token; this world's **MCP bridge token** is blank or stale | Paste the server's token into the world setting (GM once, everyone inherits) |
| `1008 auth required` in the server log | A non-browser peer, or a pre-1.0 module, connected without sending a hello while a token is enforced | Upgrade the module; a hand-written probe must send a hello carrying the token |
| Console shows a WebSocket/mixed-content error on a **hosted** world | Browser refused `ws://…` from an https page | Use the relay, or move the server to the browser's machine |
| Browser asks about "local network access" | Public page reaching loopback | Allow it, or use the relay |
| Bridge connects, then vanishes | The Foundry tab was closed, reloaded, or the machine slept | Reopen the world; the module reconnects every 5 s |
| Connects to `localhost:3001` but the server is elsewhere | Auto-derived default follows the page, not the server | Set **MCP server address** |
| `list_connected_bridges` empty on a hosted world | Module not enabled in that world, or no tab is open as GM | Manage Modules → Foundry MCP Live; open the world |
| Two GMs, same name, different worlds | Default route is ambiguous | Pass `targetUser` as `Name@host` from `list_connected_bridges` |

See [Installation & Setup](Installation-and-Setup) for the initial install,
[Settings Reference](Settings-Reference) for every setting and variable, and
[SECURITY.md](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/SECURITY.md)
for the threat model behind these gates.
