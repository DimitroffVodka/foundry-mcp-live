/**
 * Relay gateway — Node side.
 *
 * Owns a managed Chromium page joined to Foundry as an ordinary client, and
 * uses it to reach browsers the MCP server cannot talk to directly. See the
 * gateway-relay-plan artifact for why this exists at all.
 *
 * Two decisions are load-bearing and easy to undo by accident:
 *
 * 1. The page is driven over CDP (`page.evaluate`), NOT by having the page open
 *    a WebSocket back to localhost. An in-page socket would put the gateway
 *    itself under Chrome's Local Network Access checks — the very restriction
 *    this design exists to escape. Node → CDP → page is local IPC and is not
 *    subject to any browser network policy.
 *
 * 2. The keys live HERE, never in the browser. The gateway page runs
 *    unattended for long periods; if it is compromised, the attacker gets a
 *    pipe, not the ability to sign requests or decrypt results. The page only
 *    ever broadcasts envelopes we signed and hands back sealed blobs we open.
 */

import { randomUUID } from "node:crypto";
import {
  generateGatewayKeys,
  signRequest,
  openFromClient,
} from "../../module/scripts/relay-crypto.js";
import { log } from "./log.js";

const DISCOVERY_SETTLE_MS = 1_500;

export function createRelayGateway({
  foundryUrl,
  gmUser,
  gmPassword = "",
  chromePath,
  userDataDir = "",
  headless = true,
  launchBrowser,
} = {}) {
  let browser = null;
  let page = null;
  let keys = null;
  let started = false;
  let recovering = null;   // in-flight rejoin, so concurrent callers don't stampede

  async function launch() {
    const puppeteer = await import("puppeteer-core");
    const launcher = launchBrowser ?? ((opts) => puppeteer.launch(opts));
    return launcher({
      headless,
      executablePath: chromePath,
      ...(userDataDir ? { userDataDir } : {}),
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        // A headless gateway has no GPU; without this, software WebGL
        // (SwiftShader) pegs a core rendering a canvas nobody looks at.
        "--disable-gpu",
      ],
    });
  }

  /** Join the world as `gmUser`. The gateway must be GM-capable to publish keys. */
  async function joinWorld() {
    await page.goto(new URL("/join", foundryUrl).toString(), { waitUntil: "networkidle2" });

    const joined = await page.evaluate(async ({ user, pass }) => {
      const form = document.querySelector("form#join-game-form, form#join-game, form.join-form, form");
      if (!form) return { ok: false, reason: "no-join-form", at: location.href };
      // v13 shipped a user dropdown; v14.367 ships a free-text username input.
      // Neither present means the join markup moved again — say so plainly
      // rather than silently submitting a form with no user set, which lands
      // back on /join and looks like a timeout.
      const select = form.querySelector('select[name="userid"], select[name="userId"]');
      if (select) {
        const opt = [...select.options].find((o) => o.textContent.trim() === user);
        if (!opt) return { ok: false, reason: `user "${user}" not offered on the join screen` };
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const nameInput = form.querySelector('input[name="username"], input[name="userid"]');
        if (!nameInput) {
          return { ok: false, reason: "join form has neither a user select nor a username input" };
        }
        nameInput.value = user;
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const pw = form.querySelector('input[name="password"]');
      if (pw) pw.value = pass;
      form.querySelector('button[name="join"], button[type="submit"]')?.click();
      return { ok: true };
    }, { user: gmUser, pass: gmPassword });

    if (!joined.ok) {
      // "No join form" has several very different causes and guessing at one
      // sends people debugging the wrong thing. /api/status distinguishes them
      // in a single request, so ask rather than speculate.
      if (joined.reason === "no-join-form") {
        let status = null;
        try { status = await (await fetch(new URL("/api/status", foundryUrl))).json(); } catch { /* unreachable */ }
        if (status && status.active === false) {
          throw new Error(
            `No world is running on ${foundryUrl} — Foundry is sitting on the setup screen. ` +
            `Launch a world, then start the gateway.`
          );
        }
        throw new Error(
          `Gateway reached ${joined.at} but found no join form. ` +
          (status ? `Foundry reports world "${status.world}" active — the page may have been redirected.`
                  : `Foundry's /api/status was unreachable, so it may be down.`)
        );
      }
      throw new Error(`Gateway could not join: ${joined.reason}`);
    }

    // Both waits below fail as a bare "Waiting failed: Nms exceeded", which
    // says nothing about which of several very different problems occurred.
    // Diagnose instead — these are the failures a first-time setup actually
    // hits, and guessing between them costs more than the check does.
    try {
      await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60_000 });
    } catch {
      const why = await page.evaluate(() => ({
        url: location.href,
        stillOnJoin: /\/join/.test(location.pathname),
        notice: document.querySelector(".notification.error, .form-group .notes.error")?.textContent?.trim() || "",
      })).catch(() => ({}));
      throw new Error(
        `Gateway joined the page but never reached game.ready (still at ${why.url || "unknown"}).` +
        (why.notice ? ` Foundry said: "${why.notice}".` : "") +
        (why.stillOnJoin
          ? ` Still on the join screen — the most common causes are a password on "${gmUser}", ` +
            `or that user already having an active session elsewhere (Foundry allows one per user, ` +
            `so pointing the gateway at a human's login makes them fight over it). Give the gateway ` +
            `its own GM-capable user.`
          : "")
      );
    }

    try {
      await page.waitForFunction(() => !!globalThis.mcpRelay, { timeout: 30_000 });
    } catch {
      const mod = await page.evaluate(() => {
        const m = globalThis.game?.modules?.get("foundry-mcp-live");
        return { installed: !!m, active: !!m?.active, version: m?.version ?? null };
      }).catch(() => ({}));
      throw new Error(
        !mod.installed ? "foundry-mcp-live is not installed on that Foundry."
        : !mod.active  ? `foundry-mcp-live ${mod.version} is installed but not enabled in this world.`
        : `foundry-mcp-live ${mod.version} is active but exposes no relay. The relay needs >= 0.19.0-beta.1 ` +
          `with socket:true in module.json, and Foundry must be RESTARTED after installing it — package ` +
          `socket events are dropped silently until it is.`
      );
    }
  }

  return {
    get isRunning() { return started; },

    async start() {
      if (started) return;
      keys = await generateGatewayKeys();

      browser = await launch();
      page = await browser.newPage();
      page.on("console", (m) => {
        const t = m.text();
        if (t.includes("foundry-mcp-live")) log(`[gateway page] ${t}`);
      });

      await joinWorld();

      const published = await keys.publish();
      const identity = await page.evaluate(async (pub) => {
        const id = globalThis.mcpRelay.becomeGateway();
        await globalThis.mcpRelay.publishGatewayKeys(pub);
        return id;
      }, published);

      // Clients that booted before us answer the discover broadcast; give them
      // a moment to land before the first listClients() call.
      await new Promise((r) => setTimeout(r, DISCOVERY_SETTLE_MS));

      started = true;
      log(`Relay gateway ready as "${gmUser}" — clientId ${identity.clientId}`);
      return identity;
    },

    /**
     * Re-establish the gateway if its page has lost the relay.
     *
     * The Chromium process staying alive is NOT evidence the gateway works.
     * The page can be sent back to the join screen underneath it — Foundry
     * evicts a user's older session when the same user signs in elsewhere, and
     * a world restart does it too. `globalThis.mcpRelay` then no longer exists,
     * every call fails with "cannot read properties of undefined", and the
     * gateway keeps reporting itself running. That state previously required a
     * manual server restart to clear.
     */
    async ensureHealthy() {
      if (!started) throw new Error("Relay gateway is not running.");
      let alive = false;
      try { alive = await page.evaluate(() => !!globalThis.mcpRelay); } catch { alive = false; }
      if (alive) return true;

      if (recovering) return recovering;          // collapse concurrent attempts
      log("Relay gateway lost its Foundry session — rejoining…");
      recovering = (async () => {
        try {
          await joinWorld();
          const published = await keys.publish();
          await page.evaluate(async (pub) => {
            globalThis.mcpRelay.becomeGateway();
            await globalThis.mcpRelay.publishGatewayKeys(pub);
          }, published);
          await new Promise((r) => setTimeout(r, DISCOVERY_SETTLE_MS));
          log("Relay gateway rejoined.");
          return true;
        } catch (err) {
          log(`ERROR: relay gateway could not rejoin: ${err?.message || err}`);
          return false;
        } finally {
          recovering = null;
        }
      })();
      return recovering;
    },

    /** Browsers currently reachable through the relay. */
    async listClients() {
      if (!started) throw new Error("Relay gateway is not running.");
      if (!(await this.ensureHealthy())) throw new Error("Relay gateway is not connected to Foundry.");
      return page.evaluate(() => globalThis.mcpRelay.listRelayClients());
    },

    /**
     * Run a tool in a specific remote browser.
     * Signed here, broadcast by the page, sealed reply opened here.
     */
    async request(targetClientId, tool, params = {}, timeoutMs = 20_000) {
      if (!started) throw new Error("Relay gateway is not running.");
      if (!(await this.ensureHealthy())) throw new Error("Relay gateway is not connected to Foundry.");

      const envelope = await signRequest({
        v: 1,
        type: "request",
        requestId: randomUUID(),
        targetClientId,
        tool,
        params,
        nonce: randomUUID(),
        issuedAt: Date.now(),
      }, keys.signing.privateKey);

      const reply = await page.evaluate(
        (env, ms) => globalThis.mcpRelay.sendSignedRequest(env, ms),
        envelope, timeoutMs,
      );

      if (reply?.error) throw new Error(reply.error);
      if (!reply?.sealed) throw new Error("Relay reply carried no payload.");
      return openFromClient(reply.sealed, keys.sealing.privateKey);
    },

    async stop() {
      started = false;
      try { await browser?.close(); } catch { /* already gone */ }
      browser = null; page = null; keys = null;
    },
  };
}
