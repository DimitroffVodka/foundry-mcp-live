# Updating the MCP server

The project has **two halves that update separately**:

| Half | What it is | How it updates |
|---|---|---|
| **Module** (`foundry-mcp-live`) | Runs inside Foundry | Foundry's normal module-update flow (manifest → GitHub release). You get a notification in Foundry. |
| **Server** | A separate Node.js process you run on your machine | **Manual** — it has no auto-update and Foundry can't see it. |

Because the server is headless, **the module tells you when the server is out of date**: on connect it compares versions and, if the server is older (or too old to even report its version), it shows a sticky warning toast plus a one-time pop-up with the commands below. When you see that, update the server.

> **Why `npm install` matters:** some fixes are dependency changes (e.g. the zod pin that restores `tools/list`). `git pull` alone updates the code but **not** `node_modules` — always run `npm install` after pulling, or the fix won't take effect.

---

## Linux — systemd user service (recommended setup)

If you installed via `scripts/install-linux-user-service.sh`:

```bash
cd ~/foundry-mcp-live          # your clone of the repo
git pull
cd server
npm install
systemctl --user restart foundry-mcp-live
```

Verify it came back up:

```bash
systemctl --user status foundry-mcp-live   # should say "active (running)"
```

## Linux / macOS — manual launcher

If you start the server yourself with `server/start.sh`:

```bash
cd ~/foundry-mcp-live
git pull
cd server
npm install
# stop the running server (Ctrl+C in its terminal, or close that window), then:
bash start.sh
```

> **macOS note:** macOS is the same as manual Linux — it's just Node.js. Install Node from <https://nodejs.org> (or `brew install node`) if you don't have it. If you set the server up as a `launchd` agent, run `launchctl kickstart -k gui/$(id -u)/<your-label>` instead of re-running `start.sh`. If you used the manual launcher, the steps above are all you need.

## Windows

```bat
cd %USERPROFILE%\foundry-mcp-live
git pull
cd server
npm install
```

Then restart the server: **close the `start.bat` window** (this stops the server) and double-click `start.bat` again.

> No Git on Windows? Download the latest release zip from the
> [Releases page](https://github.com/DimitroffVodka/foundry-mcp-live/releases/latest),
> extract it over your existing copy, then run `npm install` in `server\` and
> restart `start.bat`.

---

## After updating

1. The module's "server out of date" warning should disappear on the next connect (reload Foundry, F5, if it's still showing).
2. If your MCP client (Claude Desktop / Claude Code) was connected, it may need to reconnect/re-initialize, since restarting the server invalidates existing sessions.

## How the version check works (for maintainers)

- Server version is read from `server/package.json` ([config.js](../server/lib/config.js) → `SERVER_VERSION`) and sent to the module in a `hello-ack` frame.
- The module compares it against its own version and a `PROTOCOL_VERSION` (bumped only on breaking handshake/tool changes — not every release).
- Keep `module.json` and `server/package.json` versions in lockstep when you cut a release, and note in the changelog whenever a release **requires a server update** (server-only fixes won't trigger a module update notification on their own).

---

## Editing the server while it is running (contributors)

`server/tools/*.js` **hot-reloads**: a saved edit reaches every *new* MCP session with no restart (an existing session keeps its old tool list until it reconnects). Nothing else does. These are loaded once per process and need `systemctl --user restart foundry-mcp-live` after an edit:

- `server/lib/*` — including a brand-new export added to an existing file
- `server/tools/_helpers.js` and `server/tools/index.js`
- `server/server.js`

**The trap:** adding an export to a `lib/` file and importing it from a tool. The tool file reloads, but the running process still holds the old `lib/` file, so the import fails with `does not provide an export named …` and that tools module fails to load. A syntax check or a fresh `node` import will *not* show this, because they load the new `lib/`. Each tools module loads in isolation, so only its tools go missing (the server used to answer every request with HTTP 500).

Check for it after editing:

```bash
journalctl --user -u foundry-mcp-live -n 50 | grep "failed to load"
```

A line like `tools/server-local.js failed to load … (lib/ is not hot-reloaded: restart the server)` means restart. A restart drops open MCP sessions; clients reconnect, and Foundry bridge clients reconnect on their own.
