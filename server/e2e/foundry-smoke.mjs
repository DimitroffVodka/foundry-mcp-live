#!/usr/bin/env node
/**
 * End-to-end smoke test against a LIVE Foundry.
 *
 * The unit suite runs against a mocked Foundry, so it proves the bridge calls
 * the right things. Only a running Foundry proves Foundry *accepted* them —
 * and the failure mode this exists to catch is the silent one: a v14 API that
 * still resolves, still returns, and quietly does nothing. Nothing throws, the
 * suite stays green, and the module is broken in every real world.
 *
 * The chain under test is the whole product:
 *
 *   this script → MCP HTTP (:3000) → server → WebSocket bridge (:3001)
 *                → module in a real Foundry tab → game API → back
 *
 * Assumes the MCP server and Foundry are already up; the workflow starts both.
 *
 *   node e2e/foundry-smoke.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";

const FOUNDRY_URL = process.env.FOUNDRY_E2E_URL      ?? "http://localhost:30000";
const GM_USER     = process.env.FOUNDRY_E2E_GM_USER  ?? "Gamemaster";
const GM_PASS     = process.env.FOUNDRY_E2E_GM_PASSWORD ?? "";
const CHROME      = process.env.FOUNDRY_CHROME_PATH  ?? "/usr/bin/chromium";
const MCP_URL     = process.env.FOUNDRY_E2E_MCP_URL  ?? "http://127.0.0.1:3000/mcp";
// The module logs under two prefixes, and a gate that knows only one is a gate
// that passes while the module is broken: handler/relay failures use
// `${MODULE_ID} | …` (bridge.js, relay.js), but ~11 other user-facing messages
// are prefixed "Foundry MCP:" and carry the id nowhere. Match both.
const OURS_RE     = /foundry-mcp-live|Foundry MCP/;
const BOOT_BUDGET_MS = Number(process.env.FOUNDRY_E2E_BOOT_MS ?? 90_000);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- Minimal MCP client over the streamable-HTTP transport -----------------
// Same handshake scratch/test-mcp.mjs uses: initialize → session id →
// notifications/initialized → tools/call. Responses come back as SSE frames.
function parseSse(text) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const frame = JSON.parse(line.slice(6));
    if (frame.result || frame.error) return frame;
  }
  throw new Error(`No JSON-RPC frame in response: ${text.slice(0, 300)}`);
}

async function mcpClient() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const init = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-smoke", version: "1.0.0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server returned no mcp-session-id");
  const sessionHeaders = { ...headers, "mcp-session-id": sessionId };

  await fetch(MCP_URL, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  let id = 2;
  return async function call(name, args = {}) {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const frame = parseSse(await res.text());
    if (frame.error) throw new Error(`${name}: ${frame.error.message}`);
    const text = frame.result?.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return text; }
  };
}

// --- Join a real world in a real browser ----------------------------------
async function joinWorld() {
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.goto(new URL("/join", FOUNDRY_URL).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForSelector("#join-game-form", { timeout: 30_000 });

  // v14 replaced the user dropdown with a free-text username input. v13 shipped
  // `select[name="userid"]`; v14.367 ships `input[name="username"]`. Handle
  // both — the whole point of this script is surviving a version bump, so it
  // may not assume either shape.
  const picked = await page.evaluate((user) => {
    const form = document.querySelector("#join-game-form");
    const select = form?.querySelector('select[name="userid"], select[name="userId"]');
    if (select) {
      const option = [...select.options].find((o) => o.textContent.trim() === user);
      if (!option) {
        return { ok: false, shape: "select", users: [...select.options].map((o) => o.textContent.trim()) };
      }
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, shape: "select" };
    }
    const input = form?.querySelector('input[name="username"], input[name="userid"]');
    if (input) {
      input.value = user;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, shape: "input" };
    }
    return { ok: false, shape: "none", users: [] };
  }, GM_USER);

  if (!picked.ok) {
    throw new Error(
      picked.shape === "none"
        ? "Join form has neither a user select nor a username input — the join markup moved again."
        : `User "${GM_USER}" not on the join page. Present: ${picked.users.join(", ")}`
    );
  }
  console.log(`  note  join form user field is a <${picked.shape}>`);
  if (GM_PASS) await page.type("#join-game-form input[name=password]", GM_PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.click("#join-game-form button[name=join]"),
  ]);

  // `game.ready` is the only honest "the world is up" signal.
  await page.waitForFunction(
    () => globalThis.game?.ready === true,
    { timeout: BOOT_BUDGET_MS, polling: 500 }
  );
  return { browser, page };
}

// --- Run -------------------------------------------------------------------
let browser;
try {
  ({ browser } = await joinWorld());
  check("a real Foundry world booted and reached game.ready", true);

  const call = await mcpClient();

  // The module connects on world load; give it a moment to appear.
  // Must be a bridge for the user WE just joined as. Asserting `length > 0`
  // passes on somebody else's already-connected client — including the
  // developer's own browser when this is run locally — which means the check
  // goes green even if the module in the new client never loaded at all.
  const mine = (list) => list.find((b) => b.userName === GM_USER);

  let list = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await call("list_connected_bridges").catch(() => ({}));
    list = res?.bridges ?? (Array.isArray(res) ? res : []);
    if (mine(list)) break;
    await sleep(1000);
  }
  const bridge = mine(list);
  check(`module connected back to the bridge as "${GM_USER}"`, !!bridge,
    bridge
      ? `${list.length} bridge(s) total, ours at ${bridge.host ?? "?"}`
      : `${list.length} bridge(s), none for "${GM_USER}": ${list.map((b) => b.userName).join(", ") || "(none)"}`);

  const info = await call("get_game_info");
  check("get_game_info round-tripped through the live game API",
    !!info?.world?.id && !!info?.system?.id,
    `world=${info?.world?.id} system=${info?.system?.id} foundry=${info?.foundryVersion ?? "?"}`);

  // --- The console-error gate ---------------------------------------------
  // The point of the whole exercise. A Foundry API that moved namespace does
  // not throw here — it logs, and the module keeps running wrong. Any console
  // error naming this module fails the build.
  const console_ = await call("get_console_errors", { sinceMs: 0, level: "error" });
  const ours = (console_?.entries ?? []).filter((e) =>
    OURS_RE.test(JSON.stringify(e))
  );
  check("no console error names this module", ours.length === 0,
    ours.length ? ours.map((e) => e.message ?? JSON.stringify(e)).join(" | ").slice(0, 400) : "");

  // Anything else in the buffer is reported but does not fail: another
  // module's error is not ours to fix, and failing on it teaches everyone to
  // ignore this check.
  const foreign = (console_?.entries ?? []).length - ours.length;
  if (foreign > 0) console.log(`  note  ${foreign} console error(s) from other sources (not failing)`);
} catch (err) {
  check("run completed without throwing", false, err?.message || String(err));
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAILED" : "OK"} — ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
