# Error catalogue

Stable codes for setup failures — the errors you hit when the bridge will not
connect or refuses to act. Each one says what happened, why, and the fix.

Codes live in [`server/lib/errors.js`](../server/lib/errors.js). A code without
a section here (or a section without a code) fails `npm test`.

---

## FML-0001

**No GM bridge connected.**

The MCP server is running and your client reached it, but no Foundry browser
tab has connected back to the bridge as a GM.

Fix, in order of likelihood:

1. Is Foundry open, joined to a world, as a **GM user**? The module connects on
   world load, not on the setup/join screen.
2. Is the module enabled in that world? *Game Settings → Manage Modules →
   Foundry MCP Live*.
3. Check the server log for `bridge connected`. If it never appears, the module
   cannot reach `ws://127.0.0.1:3001` — see `FOUNDRY_WS_HOST` in
   [SECURITY.md](../SECURITY.md).
4. Reload the Foundry tab. The module retries every 5s, but a tab open since
   before the server started may be waiting on a stale socket.

## FML-0002

**No bridge connected for the requested user.**

You passed `targetUser`, and nobody by that name is connected. The message
lists who *is* connected.

Fix: call `list_connected_bridges` and use a name from that list. Names are
matched exactly, and can be given as `userName`, `userName@host`, or the raw
user id. Multi-user routing is described in [README.md](../README.md#multi-user-routing).

## FML-0003

**Write-gated tool called while `FOUNDRY_MCP_ALLOW_WRITE` is unset.**

Tools that create or modify persistent world data are off by default, so a
hallucinating client cannot mutate your world on a default install.

Fix: set `FOUNDRY_MCP_ALLOW_WRITE=1` in the **server's** environment and
restart it. Note that most write tools are not merely refused when the gate is
off — they are never registered, so they do not appear in the tool list at all.
`chat` is the exception: it registers either way, because `action: "read"`
works ungated, and only `action: "send"` raises this code.

See [SECURITY.md](../SECURITY.md#opt-in-enable-world-authoring) before turning
it on.

## FML-0004

**Invalid or missing bearer token.**

`BRIDGE_TOKEN` is set on the server, so `/mcp` and `/api/usage` require
`Authorization: Bearer <token>`, and what arrived did not match.

Fix: send the header, or unset `BRIDGE_TOKEN` if you are on a single-user
machine and do not need it. The two tokens (`BRIDGE_TOKEN` for HTTP,
`FOUNDRY_WS_TOKEN` for the WebSocket) are separate and gate different
endpoints — see [SECURITY.md](../SECURITY.md#opt-in-token-auth).

## FML-0005

**Client relaunch is misconfigured.**

`relaunch_client` was called but its configuration does not validate. The
message names every failing field at once.

Fix: the required set is `FOUNDRY_RELAUNCH_ENABLED=1`, `FOUNDRY_CHROME_PATH`,
`FOUNDRY_RELAUNCH_GM_USER`, and a valid `FOUNDRY_RELAUNCH_URL`. The URL must
not embed credentials, and must be loopback unless you also set
`FOUNDRY_RELAUNCH_ALLOW_REMOTE=1`. See
[SECURITY.md](../SECURITY.md#opt-in-gm-client-relaunch).
