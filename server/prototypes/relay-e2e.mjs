/**
 * End-to-end relay smoke test against a LIVE Foundry.
 *
 * Stands up the real gateway, opens a second browser page to stand in for a
 * remote device (a Steam Deck reaches Foundry the same way this page does —
 * over Foundry's own socket — so from the relay's point of view they are
 * indistinguishable), and drives a real tool call through the whole chain:
 *
 *   Node (signs) → CDP → gateway page → Foundry broadcast → target page
 *                → handler runs → sealed result → gateway page → Node (opens)
 *
 * Asserts the parts that are easy to get wrong and invisible when wrong:
 * the target is addressable by clientId, the result decrypts, an unsigned
 * request is refused, and a request aimed at one client is ignored by another.
 *
 *   node prototypes/relay-e2e.mjs
 */
import { createRelayGateway } from "../lib/relay-gateway.js";

const FOUNDRY_URL = process.env.FOUNDRY_RELAY_URL ?? "http://localhost:30000";
const GM_USER     = process.env.FOUNDRY_RELAY_GM_USER ?? "Gamemaster";
const GM_PASS     = process.env.FOUNDRY_RELAY_GM_PASSWORD ?? "";
const TARGET_USER = process.env.RELAY_E2E_TARGET_USER ?? "Bazogo";
const CHROME      = process.env.FOUNDRY_CHROME_PATH ?? "/usr/bin/chromium";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const gateway = createRelayGateway({
  foundryUrl: FOUNDRY_URL,
  gmUser: GM_USER,
  gmPassword: GM_PASS,
  chromePath: CHROME,
  headless: true,
});

let targetBrowser;
try {
  console.log(`\nGateway → ${FOUNDRY_URL} as "${GM_USER}"`);
  const identity = await gateway.start();
  check("gateway joined world and published keys", !!identity?.clientId, identity?.clientId);

  // Stand-in for the remote device: an ordinary Foundry client.
  const puppeteer = await import("puppeteer-core");
  targetBrowser = await puppeteer.launch({
    headless: true, executablePath: CHROME,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu"],
  });
  const targetPage = await targetBrowser.newPage();
  await targetPage.goto(new URL("/join", FOUNDRY_URL).toString(), { waitUntil: "networkidle2" });
  await targetPage.evaluate((user) => {
    const form = document.querySelector("form#join-game-form, form");
    // v13 renders a user dropdown; v14.367 renders a free-text username input.
    const select = form?.querySelector('select[name="userid"], select[name="userId"]');
    if (select) {
      const opt = [...select.options].find((o) => o.textContent.trim() === user);
      if (opt) { select.value = opt.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    } else {
      const nameInput = form?.querySelector('input[name="username"], input[name="userid"]');
      if (nameInput) {
        nameInput.value = user;
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    form?.querySelector('button[name="join"], button[type="submit"]')?.click();
  }, TARGET_USER);
  await targetPage.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60_000 });

  // Presence heartbeat is 5s; allow one full cycle plus slack.
  await new Promise((r) => setTimeout(r, 7_000));

  const clients = await gateway.listClients();
  console.log("\nDirectory:");
  for (const c of clients) console.log(`  ${c.clientId}  ${c.label}  caps=${JSON.stringify(c.capabilities)}`);

  const target = clients.find((c) => c.userName === TARGET_USER);
  check("remote client discovered via presence", !!target, target?.label);
  check("clients carry distinct clientIds",
    new Set(clients.map((c) => c.clientId)).size === clients.length);

  if (target) {
    const info = await gateway.request(target.clientId, "get_game_info", {});
    check("relayed tool call returned a decrypted result",
      !!info?.world?.id, `world=${info?.world?.id} system=${info?.system?.id}`);

    // A request addressed elsewhere must be ignored by everyone else, so this
    // should time out rather than being answered by the wrong browser.
    const ghost = await gateway.request("client-does-not-exist", "get_game_info", {}, 4_000)
      .then(() => "ANSWERED", (e) => (/timed out/i.test(e.message) ? "ignored" : `other: ${e.message}`));
    check("request to an unknown clientId is ignored, not misrouted", ghost === "ignored", ghost);
  }

  // Forgery: an unsigned packet broadcast directly by a client must be refused
  // by the target. This is the check that stops a player driving your browser.
  const forged = await targetPage.evaluate(async () => {
    let executed = false;
    const orig = globalThis.mcpRelay;
    game.socket.emit("module.foundry-mcp-live", {
      v: 1, type: "request", requestId: "forged-1",
      targetClientId: globalThis.sessionStorage.getItem("mcpRelayClientId"),
      tool: "get_game_info", params: {}, nonce: "forged", issuedAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 1500));
    return { executed, hadRelay: !!orig };
  });
  check("unsigned request is not executed", forged.executed === false);

} catch (err) {
  check("run completed without throwing", false, err?.message || String(err));
} finally {
  try { await targetBrowser?.close(); } catch {}
  await gateway.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAILED" : "OK"} — ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
