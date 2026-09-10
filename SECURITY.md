# Security model

## Threat model

This is a **local developer tool**, not a production-grade service. The default install assumes:

- The MCP server and AI client run on the **same physical machine**.
- That machine is **single-user** (typically your gaming/dev PC).
- The Foundry browser session runs in **your** browser.

Both ports bind to `127.0.0.1` only — nothing is exposed to the LAN or the internet by default.

The one supported way to widen that is `FOUNDRY_WS_HOST`, which exposes the **WebSocket bridge** (3001) so a second device on your LAN can connect its Foundry client. The MCP HTTP endpoint (3000) is bound to `127.0.0.1` in code and is not configurable. If you set `FOUNDRY_WS_HOST` to anything non-loopback, set `FOUNDRY_WS_TOKEN` with it — see [Opt-in: token auth](#opt-in-token-auth).

If your environment doesn't fit those assumptions (shared workstation, public terminal, multi-tenant VPS), turn on the auth options below.

## What the bridge can do

The bridge exposes a set of MCP tools that read and modify Foundry state, plus an optional `evaluate` tool that runs arbitrary JavaScript in your Foundry browser context. Tools can:

- Read every actor, item, journal, scene, compendium entry, and console log.
- Move tokens, open/close doors, toggle conditions, target tokens.
- (Opt-in) Create persistent world data — actors, items, journals, folders.
- (Opt-in) Execute arbitrary JS as the logged-in Foundry user (typically the GM).

Treat the MCP endpoint with the same trust you'd give a logged-in GM browser session.

## Built-in mitigations

- **Loopback binding.** HTTP (3000) binds to `127.0.0.1` unconditionally. WebSocket (3001) binds to `127.0.0.1` unless you deliberately widen it with `FOUNDRY_WS_HOST`; when you do and no bridge token is set, the server logs a warning at startup naming the exposure.
- **CORS lockdown.** The HTTP server rejects any `Origin` header that isn't `localhost` / `127.0.0.1` / `[::1]`. CLI clients (no `Origin`) and the proxy.mjs stdio bridge are unaffected. A malicious site visited in another tab cannot POST to the MCP endpoint with a custom JSON Content-Type without a preflight, and the preflight gets a 403.
- **`evaluate` is opt-in.** The most dangerous tool is disabled unless `FOUNDRY_MCP_ALLOW_EVAL=1` is set in the server's environment.
- **World-authoring tools are opt-in.** `create_folder`, `create_actor`, `create_actor_from_compendium`, `add_items_to_actor`, `create_journal_entry`, and `update_journal_page` are disabled unless `FOUNDRY_MCP_ALLOW_WRITE=1` is set. With the gate off they aren't even registered, so they don't appear in any MCP client's tool list.
- **`self_test` has a second gate.** It requires both the write gate and `FOUNDRY_MCP_ALLOW_SELF_TEST=1`, plus a literal `confirm: true`. Cleanup is limited to documents carrying the current run's unique flag.
- **Client relaunch is opt-in and loopback-only by default.** `relaunch_client` is absent unless `FOUNDRY_RELAUNCH_ENABLED=1`. It rejects credentials embedded in URLs and non-loopback Foundry hosts unless remote use is explicitly enabled.
- **Vendored dependencies.** `html2canvas` is bundled in `module/lib/`; the module never fetches code from a CDN at runtime.

## What leaves your machine

Nothing. This section exists so you don't have to take that on faith.

**The Foundry module** (`module/`) makes no outbound requests. It opens one
WebSocket to the bridge — `127.0.0.1:3001` by default, or whatever you set
`FOUNDRY_WS_HOST`/`FOUNDRY_BRIDGE_URL` to — and talks to nothing else.
`html2canvas` is vendored in `module/lib/` precisely so no CDN is contacted at
render time. There is no telemetry, no analytics, no version ping, no
crash reporter.

**The MCP server** (`server/`) makes exactly three kinds of outbound request,
all to hosts you configured and all normally loopback:

| What | Where | When |
|---|---|---|
| `GET /api/status` | your Foundry URL | relay gateway health check |
| Chrome DevTools Protocol | the local Chromium it launched | screenshots, recording, relaunch |
| npm registry | — | `npm install` only, never at runtime |

**What is written to disk, and stays there:**

| File | Contents | Notes |
|---|---|---|
| `server/usage-telemetry.jsonl` | One line per tool call: name, ok/error, duration, a truncated args preview, and a truncated `evaluate` body | Local only. Gitignored. On by default — `FOUNDRY_MCP_USAGE=0` disables, `FOUNDRY_MCP_USAGE_LOG=<path>` redirects |
| `GET /api/usage` | In-memory aggregate (counts, error rates, durations). No args, no eval bodies | Loopback; behind `BRIDGE_TOKEN` when one is set |
| bridge token store | The generated WebSocket token | Written on first run so you don't have to paste one |

The telemetry log can contain fragments of your world data, because it records
argument previews. That is why it never leaves the machine and why it is in
`.gitignore` — but if you are about to attach a debug bundle to an issue,
that is the file to check first.

**What the AI client sees** is a separate question, and a larger one: any tool
result you let it read is data you have handed to that client's operator. See
[Known residual risks](#known-residual-risks).

## Opt-in: token auth

There are two tokens, because the two endpoints have very different exposure.

| Var | Gates | Use it when |
|---|---|---|
| `FOUNDRY_WS_TOKEN` | The WebSocket bridge only | You set `FOUNDRY_WS_HOST` to let a LAN device connect. Loopback MCP clients stay unauthenticated and keep working untouched. |
| `BRIDGE_TOKEN` | The bridge **and** `/mcp` | You want Bearer auth on the HTTP endpoint too — a shared workstation, or defense-in-depth against local processes. |

`FOUNDRY_WS_TOKEN` defaults to `BRIDGE_TOKEN`, so a single-token setup behaves exactly as it always has.

Prefer `FOUNDRY_WS_TOKEN` for the LAN case. `/mcp` is bound to `127.0.0.1` in code and can't be reached off-box regardless, so putting Bearer auth on it buys nothing there — while costing you every MCP client that can't send a header.

```bash
# bridge only — the LAN case, if you want to choose the value yourself
FOUNDRY_WS_TOKEN=$(openssl rand -hex 24)
```

**You do not have to do that.** If the bridge is bound past loopback and no token is configured, the server generates one on first start and saves it to `bridge-token` in its config directory (`~/.config/foundry-mcp-live/` on Linux and macOS, `%APPDATA%\foundry-mcp-live\` on Windows), mode `0600`. It is reused on every later start, so the value stays stable. A token you set yourself always wins and is never copied to disk.

**And you do not have to transcribe it into Foundry.** A GM client that the server already trusts without a token — same machine, Foundry origin — receives the token in the connection handshake and writes it into that world's *MCP bridge token* setting. Foundry serves world settings to every client in the world, so the phone or tablet that genuinely has to authenticate finds it already there. A world setting that disagrees with the server is overwritten, since a stale token is exactly what locks a world's remote clients out.

Nothing is handed to a client that isn't already trusted, and nothing is handed to a player — only a GM can write a world setting, so sending it to anyone else would leak it for no benefit. A loopback-only bridge never generates a token at all.

**The token applies to clients from another machine, not to yours.** A Foundry client connecting over loopback is already running as the user who owns the server process, so requiring it to authenticate protects nothing — while costing a pasted secret in every world you create, and failing with a silent reconnect loop when you forget. So a peer on the loopback interface skips the token check, and the LAN clients the token exists for are unaffected.

Loopback alone isn't enough to be trusted, because CORS does not apply to WebSockets: any page you happen to visit can open a socket to `127.0.0.1`. The discriminator is the browser's `Origin` header, which page JavaScript cannot forge. A local peer is trusted when:

- the connection is not proxied (an `X-Forwarded-*` header means the loopback address belongs to the proxy, not the peer), **and**
- its `Origin` is a loopback URL, or is listed in `FOUNDRY_WS_ALLOWED_ORIGINS`, or is absent entirely (no `Origin` means no browser — a script or test harness, which on loopback is already user-privileged).

`Origin: null` — a sandboxed iframe or a `file://` page — is refused, since a hostile page can arrange it deliberately. A world setting holding a stale token still connects locally; the server logs a note that the value would fail from another machine.

**Who ends up holding the token.** The Foundry-side value lives in a world-scoped module setting, which Foundry serves to every client that loads the world. That is the point — it's what removes the per-device setup step — but it does mean the token is readable by anyone who can log into the world, not just the GM. The trade is deliberate:

| Bridge binding | Who can register a bridge |
|---|---|
| `127.0.0.1` (default) | Anyone with access to the server machine |
| Non-loopback, no token | **Anything that can route to the port** |
| Non-loopback + world token | Anyone who can log into your Foundry world |

The middle row is the one worth avoiding. The bottom row narrows the trusted set back down to your players — people already able to act in the world. If you need the token withheld from players too, leave the setting blank and set `localStorage.mcpBridgeToken` per client instead.

### Both endpoints

Set a shared secret when you want to require auth for every client and bridge:

```bash
# server side
BRIDGE_TOKEN=$(openssl rand -hex 32) npm start    # macOS/Linux
```

```powershell
# Windows PowerShell
$env:BRIDGE_TOKEN = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
npm start
```

With `BRIDGE_TOKEN` set, every connection must authenticate:

| Client | How to pass the token |
|---|---|
| Claude Desktop / Code (via `proxy.mjs`) | Set the same `BRIDGE_TOKEN` env var in the shell that spawns proxy.mjs — proxy.mjs forwards it as `Authorization: Bearer …` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.foundry] http_headers = { Authorization = "Bearer YOUR_TOKEN" }` |
| Gemini CLI | `.gemini/settings.json` → add `"headers": { "Authorization": "Bearer YOUR_TOKEN" }` next to the `url` |
| Claude Code (HTTP transport) | `claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp -H "Authorization: Bearer YOUR_TOKEN"` |
| Foundry browser module | GM sets **Module Settings → Foundry MCP Live → MCP bridge token**. World-scoped, so every client in the world picks it up automatically. Per-client override: `localStorage.setItem("mcpBridgeToken", "YOUR_TOKEN")` in the browser console, then reload. |

Without the matching token: HTTP returns `401`, WebSocket is closed with code `1008`.

## Opt-in: enable `evaluate`

```bash
FOUNDRY_MCP_ALLOW_EVAL=1 npm start
```

You probably want this enabled for serious work — most module debugging benefits from `evaluate`. The opt-in is so that someone trying the bridge for the first time doesn't accidentally hand RCE to a misbehaving AI.

Background evaluations use the same trust model. `job_result` does not grant
additional execution ability; it only retrieves bounded results from work
already started by `evaluate`. The store limits individual results to 8 MiB,
total retained data to 32 MiB, and concurrent jobs to 10.

## Opt-in: enable world authoring

```bash
FOUNDRY_MCP_ALLOW_WRITE=1 npm start
```

Enables `create_folder`, `create_actor`, `create_actor_from_compendium`, `add_items_to_actor`, `create_journal_entry`, and `update_journal_page` — all tools that create or modify persistent world data (actors, journals, folders).

These are safer than `evaluate` (no arbitrary code execution) but still write to your world. A misbehaving AI could litter your sidebar with junk folders or overwrite a journal page. Foundry's undo stops at the page level for journals, so a single `update_journal_page` with `content` (vs. `appendContent`) replaces the body and isn't recoverable from the UI.

For Codex CLI users: pairing this opt-in with per-tool `approval_mode = "approve"` on at least `update_journal_page` is a reasonable belt-and-suspenders setup.

## Opt-in: schema self-test

```bash
FOUNDRY_MCP_ALLOW_WRITE=1 FOUNDRY_MCP_ALLOW_SELF_TEST=1 npm start
```

The `self_test` tool temporarily creates an Actor, JournalEntry/Page,
RollTable/TableResult, and Scene/Level. It always attempts cleanup in
reverse order. Before deleting anything, it verifies the document still
carries the unique flag for that exact run. Use a disposable or backed-up
world even with these safeguards.

## Opt-in: GM client relaunch

`relaunch_client` starts a real Chrome/Chromium process through
`puppeteer-core` and joins the configured Foundry world. It is disabled unless
all of the following are configured:

```powershell
$env:FOUNDRY_RELAUNCH_ENABLED = "1"
$env:FOUNDRY_RELAUNCH_URL = "http://localhost:30000"
$env:FOUNDRY_RELAUNCH_GM_USER = "Gamemaster"
$env:FOUNDRY_CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:FOUNDRY_CHROME_USER_DATA_DIR = "C:\path\to\dedicated-foundry-profile"
$env:FOUNDRY_RELAUNCH_GM_PASSWORD = "" # optional
```

- Keep the Chrome profile dedicated to Foundry automation.
- Put the GM password only in the server environment. It is not accepted as
  a tool argument and is redacted from returned errors.
- Remote Foundry URLs are rejected by default. Setting
  `FOUNDRY_RELAUNCH_ALLOW_REMOTE=1` opts into sending the configured password
  to that remote origin; use HTTPS and understand the trust boundary.
- When the matching GM bridge is already connected, the tool returns without
  launching another browser.

## Known residual risks

- **Read-out of sensitive state.** Even without `evaluate`, tools like `get_actor`, `get_console_errors`, and `snapshot_actor` expose the full game state, including GM-only flags and notes. If a connected AI client decides to read everything and exfiltrate it, the bridge will let it. Mitigation: only connect AI clients you trust to handle your game data.
- **Hot-reload of `server/tools/`.** If an attacker can write to the filesystem, they can drop a malicious tool file and the server will pick it up on next request. Not a new attack surface — at that level of access they already own you.
- **Multi-user routing.** With `targetUser` set, a tool runs in *that user's* browser context with their permissions. The server enforces routing but not authorization on which user a client is allowed to target. If you connect a non-trusted client and trust it to act as a specific player, it can act as ANY connected user.
- **Chrome profile and environment secrets.** A local process with access to
  the server environment or the dedicated Chrome profile can recover the GM
  credential/session. Protect them with normal OS account permissions.

## Reporting

If you find a vulnerability, open a private GitHub security advisory on the repo rather than filing a public issue.
