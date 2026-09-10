/**
 * Server-local tools — these don't proxy to the Foundry bridge. They run
 * entirely in the MCP server process and inspect / orchestrate bridge
 * connections directly.
 *
 *   - `list_connected_bridges` — discovery affordance for `targetUser`
 *   - `reload_foundry`         — orchestrated reload + reconnect + ready wait
 */
import { z }                                from "zod";
import { bridges, lastSeenBridges, reconnectWaiters, routeBridge } from "../lib/bridges.js";
import { FOUNDRY_URLS, RELAUNCH_CONFIG }    from "../lib/config.js";
import { diagnoseBridgeStatus }             from "../lib/bridge-status.js";
import { relaunchClient }                   from "../lib/relaunch.js";
import { requestFoundry }                   from "../lib/foundry-rpc.js";
import { relayClients }                     from "../lib/relay-runtime.js";
import { registerRawTool }                  from "./_helpers.js";

function getBridgeDiagnosis() {
  return diagnoseBridgeStatus({
    bridges,
    lastSeenBridges,
    configuredOrigins: FOUNDRY_URLS,
  });
}

function diagnosisReply(error, diagnosis) {
  return { content: [{ type: "text", text: JSON.stringify({
    error,
    diagnosis,
  }, null, 2) }] };
}

export function registerServerLocalTools(mcp) {
  registerRawTool(mcp, "list_connected_bridges",
    "List all Foundry users currently connected via the bridge module. "
    + "Use `userName` (or `userName@host` to disambiguate when the same "
    + "name is connected from two worlds) as the `targetUser` parameter "
    + "on other tools to route calls. `userId` also works as an "
    + "unambiguous escape hatch. The GM is the default target.",
    {},
    async () => {
      const list = [...bridges.values()]
        .filter(b => b.userId !== "__legacy__")
        .map(b => ({
          userId:      b.userId,
          userName:    b.userName,
          host:        b.host || "",
          isGM:        b.isGM,
          connectedAt: new Date(b.connectedAt).toISOString(),
        }))
        .sort((a, b) => {
          if (a.isGM !== b.isGM) return a.isGM ? -1 : 1;
          return a.userName.localeCompare(b.userName);
        });

      // Surface the targetable string per bridge: the bare userName if it
      // is unique across connected bridges, otherwise "userName@host".
      const nameCounts = new Map();
      for (const b of list) nameCounts.set(b.userName, (nameCounts.get(b.userName) ?? 0) + 1);
      for (const b of list) {
        b.targetUser = (nameCounts.get(b.userName) > 1 && b.host)
          ? `${b.userName}@${b.host}`
          : b.userName;
      }

      const result = { bridges: list };

      // Relayed clients are reached through Foundry rather than a direct
      // socket, so they never appear in `bridges` — but they are exactly as
      // targetable, and for a remote device they are the ONLY way to target
      // it. Listing them separately keeps the distinction visible (a relayed
      // client depends on the gateway being up) without hiding them.
      try {
        const relayed = await relayClients();
        if (relayed.length) {
          result.relayedClients = relayed
            .map((c) => ({
              clientId:     c.clientId,
              label:        c.label,
              userName:     c.userName,
              isGM:         c.isGM,
              capabilities: c.capabilities,
              lastSeenMsAgo: c.ageMs,
              // clientId is always unambiguous; a shared userName is not,
              // which is the collision the direct registry gets wrong.
              targetUser:   c.clientId,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
          result.relayNote = "Relayed clients are reached through Foundry's own socket via the "
            + "gateway browser. Address them by `clientId` or device label — a shared `userName` "
            + "is ambiguous when one person is signed in on two devices.";
        }
      } catch { /* gateway down or mid-restart; direct bridges still listed */ }

      if (bridges.has("__legacy__")) {
        result.legacyBridgeConnected = true;
        result.note = "A pre-multi-user bridge is connected and is being treated as the default GM. "
          + "Update the foundry-mcp-live module so it identifies itself for direct addressing.";
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

  registerRawTool(mcp, "bridge_status",
    "Diagnose the MCP-to-Foundry connection without requiring a live bridge. "
    + "Reports connected and last-seen bridges, probes known Foundry /api/status "
    + "endpoints, and classifies the state as bridge-connected, "
    + "foundry-up-no-bridge, foundry-up-no-users, foundry-down, or unknown.",
    {},
    async () => {
      const result = await getBridgeDiagnosis();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

  if (RELAUNCH_CONFIG.enabled) {
    registerRawTool(mcp, "relaunch_client",
      "Launch the explicitly configured Chrome executable, join the configured "
      + "Foundry world as the configured GM, and wait for its MCP bridge. "
      + "This server-local recovery tool is absent unless "
      + "FOUNDRY_RELAUNCH_ENABLED=1. Credentials are read only from the server "
      + "environment and are never accepted as tool parameters or returned.",
      {
        timeoutMs: z.number().min(5_000).max(120_000).optional().describe(
          "Total ms to allow for Chrome launch, Foundry join, and bridge registration. "
          + "Default 30000."
        ),
      },
      async params => {
        const result = await relaunchClient(params);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      });
  }

  registerRawTool(mcp, "reload_foundry",
    "Reload a Foundry tab and wait until it has reconnected its bridge AND "
    + "`game.ready` is true. Use after editing module code that needs to be "
    + "re-read by the browser. Targets the GM by default; pass `targetUser` "
    + "for a specific player tab. Saves the manual reload + sleep + poll "
    + "dance and avoids the 'Server not initialized' race that happens when "
    + "you call MCP tools too soon after a raw `evaluate(window.location.reload())`.\n\n"
    + "Set `hardReload: true` to clear the browser's Cache API and unregister "
    + "service workers before reloading — use this after editing bridge/module "
    + "code to guarantee Foundry picks up the new JS/CSS instead of serving stale "
    + "cached files. Default (false) does a cache-busting location.replace() which "
    + "busts the HTML cache but not module/service-worker caches.",
    {
      targetUser: z.string().optional().describe(
        'Foundry user whose tab to reload. Omit (or pass "GM" / "self") to '
        + 'target the GM (default). Pass a player\'s exact user name to reload '
        + 'their tab. Use list_connected_bridges to see who is currently connected.'
      ),
      hardReload: z.boolean().optional().describe(
        "Clear Cache API caches and unregister service workers before reloading. "
        + "Default false. Set true after editing bridge/module JS to bypass "
        + "Foundry's service-worker and module cache."
      ),
      timeoutMs: z.number().optional().describe(
        "Total ms to wait for reconnect AND game.ready. Default 30000 (30s). "
        + "Hard reloads may need extra time for cache revalidation — bump to "
        + "60000 if service worker re-registration is slow."
      ),
    },
    async ({ targetUser, hardReload = false, timeoutMs = 30_000 }) => {
      let bridge;
      try { bridge = routeBridge(targetUser); }
      catch (err) {
        return diagnosisReply(err.message, await getBridgeDiagnosis());
      }

      // Refuse to reload through the legacy fallback bucket — it can't
      // satisfy our hello-waiter (legacy bridges never send hello), so the
      // wait would always time out at 30s. Tell the user how to proceed.
      if (bridge.userId === "__legacy__") {
        return { content: [{ type: "text", text:
          "Error: reload_foundry requires a multi-user-aware bridge "
          + "(foundry-mcp-live v0.2.0+). The targeted bridge appears to "
          + "be a legacy install. Upgrade the bridge module, or run "
          + "`evaluate({expression: \"window.location.reload()\"})` manually "
          + "and reconnect Claude Code on your own."
        }] };
      }

      const targetUserId   = bridge.userId;
      const targetUserName = bridge.userName;
      const reloadStartedAt = Date.now();

      // Issue a reload via evaluate. Two modes:
      //   soft (default): cache-busting query-param on location.replace() —
      //     bypasses the HTML cache but NOT the service-worker / module cache.
      //   hard (hardReload=true): clears all Cache API caches, unregisters
      //     service workers for this origin, then forces a hard reload.
      // The setTimeout(50) gives the eval a chance to return before the
      // browser navigates away. Reply may never arrive (socket closes
      // mid-handler) — that's expected, so we ignore failures here and
      // proceed straight to the wait.
      const reloadExpr = hardReload
        ? "setTimeout(async () => { "
        +   "try { "
        +     "const keys = await caches.keys(); "
        +     "await Promise.all(keys.map(k => caches.delete(k))); "
        +   "} catch(e) {} "
        +   "try { "
        +     "const regs = await navigator.serviceWorker?.getRegistrations?.(); "
        +     "if (regs) await Promise.all(regs.map(r => r.unregister())); "
        +   "} catch(e) {} "
        +   "window.location.reload(); "
        + "}, 50); "
        + "'cache cleared + reloading'"
        : "setTimeout(() => { "
        +   "const u = new URL(window.location.href); "
        +   "u.searchParams.set('_mcpReload', Date.now()); "
        +   "window.location.replace(u.toString()); "
        + "}, 50); "
        + "'reloading'";
      try {
        await requestFoundry("evaluate", {
          expression: reloadExpr,
        }, targetUserId);
      } catch { /* expected — socket closes during reload */ }

      // Wait for the new bridge with the same userId to announce via hello.
      const helloDeadlineMs = Math.max(1000, timeoutMs - (Date.now() - reloadStartedAt));
      let newBridge;
      try {
        newBridge = await new Promise((resolve, reject) => {
          // Replace any prior waiter for this user — last one wins.
          const prev = reconnectWaiters.get(targetUserId);
          if (prev) {
            clearTimeout(prev.timer);
            prev.reject(new Error("Superseded by a newer reload_foundry call"));
          }
          const timer = setTimeout(() => {
            reconnectWaiters.delete(targetUserId);
            reject(new Error(
              `Timeout waiting for ${targetUserName} to reconnect after reload (${helloDeadlineMs}ms)`
            ));
          }, helloDeadlineMs);
          reconnectWaiters.set(targetUserId, { resolve, reject, timer });
        });
      } catch (err) {
        return diagnosisReply(err.message, await getBridgeDiagnosis());
      }
      const reconnectedAt = Date.now();

      // Poll game.ready with a short interval until the remaining timeout.
      // Bridge returns `{ result, evalMs }` — read `.result`.
      const readyDeadline = reloadStartedAt + timeoutMs;
      let gameReadyAt = null;
      while (Date.now() < readyDeadline) {
        try {
          const reply = await requestFoundry("evaluate", {
            expression: "return game?.ready === true;",
          }, targetUserId);
          if (reply?.result === true) { gameReadyAt = Date.now(); break; }
        } catch { /* not ready yet, keep polling */ }
        await new Promise(r => setTimeout(r, 200));
      }

      if (!gameReadyAt) {
        return { content: [{ type: "text", text: JSON.stringify({
          ready: false,
          targetUser: targetUserName,
          reloadStartedAt: new Date(reloadStartedAt).toISOString(),
          reconnectedAt:   new Date(reconnectedAt).toISOString(),
          note: "Bridge reconnected but game.ready never became true within timeoutMs",
        }, null, 2) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({
        ready: true,
        targetUser:        targetUserName,
        reloadStartedAt:   new Date(reloadStartedAt).toISOString(),
        reconnectedAt:     new Date(reconnectedAt).toISOString(),
        gameReadyAt:       new Date(gameReadyAt).toISOString(),
        totalDurationMs:   gameReadyAt - reloadStartedAt,
        helloLatencyMs:    reconnectedAt - reloadStartedAt,
        readyLatencyMs:    gameReadyAt - reconnectedAt,
      }, null, 2) }] };
    });
}
