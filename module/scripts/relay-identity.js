/**
 * Relay client identity.
 *
 * Extracted pure so it can be unit-tested under Node (bridge.js touches
 * `game`/`Hooks` at module scope), following auto-connect.js / bridge-url.js.
 *
 * Three ids, and conflating them is the bug this replaces:
 *
 *   userId   – Foundry's auth context. NOT unique per browser: a desktop and a
 *              Steam Deck signed in as the same GM share it. The old bridge
 *              registry keyed on this, so the second tab silently evicted the
 *              first.
 *   clientId – the execution target. Stable across reloads of one tab (kept in
 *              sessionStorage, which is per-tab and dies with it), so a target
 *              stays addressable while you reload it.
 *   bootId   – one page load. Regenerated every time. Sequence numbers reset
 *              per boot, so without this a fresh boot's `seq: 1` looks like a
 *              replay of the previous boot's traffic and gets dropped.
 */

const CLIENT_ID_KEY = "mcpRelayClientId";

/** Crypto-random id. Falls back only where getRandomValues is unavailable. */
export function newId(prefix) {
  let rand;
  try {
    const buf = new Uint8Array(9);
    globalThis.crypto.getRandomValues(buf);
    rand = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    rand = Math.floor(Math.random() * 1e15).toString(16);
  }
  return `${prefix}-${rand}`;
}

/**
 * Stable per-tab client id. sessionStorage is deliberate: localStorage would
 * make every tab in a browser share one id (so two tabs would fight over being
 * the same target), and a plain in-memory id would change on every reload,
 * orphaning the gateway's directory entry each time you refresh.
 *
 * @param {Storage} [store] injectable for tests
 */
export function resolveClientId(store) {
  const s = store ?? (() => { try { return globalThis.sessionStorage; } catch { return null; } })();
  if (!s) return newId("client");            // storage blocked → per-boot id
  try {
    const existing = s.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fresh = newId("client");
    s.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return newId("client");
  }
}

/**
 * What this browser can actually do. Used for ROUTING, never authorization —
 * a headless gateway has no canvas, so it must not be picked for PIXI work,
 * and only a device with a gamepad can answer gamepad queries.
 */
/**
 * Human-facing device label.
 *
 * Screen size is included because platform strings alone are not
 * distinguishable in practice: SteamOS's Firefox reports plain
 * "X11; Linux x86_64", identical to a desktop. Without a size, a Steam Deck
 * (1280x800) and a desktop window are the same string, and picking the wrong
 * target is silent.
 */
export function describeClient(env = globalThis) {
  const ua = env.navigator?.userAgent ?? "";
  // Physical pixels, not CSS pixels. screen.width is in CSS pixels and scales
  // with devicePixelRatio, so a Steam Deck at dpr 0.8 reports 1600x1000 for a
  // 1280x800 panel — which is how a real Deck failed a "is this 1280x800"
  // check and got labelled a desktop.
  const dpr = env.devicePixelRatio || 1;
  const w = env.screen?.width ? Math.round(env.screen.width * dpr) : 0;
  const h = env.screen?.height ? Math.round(env.screen.height * dpr) : 0;
  const size = w && h ? ` ${w}x${h}` : "";
  const platform =
    /SteamOS|Steam ?Deck/i.test(ua) ? "Steam Deck" :
    (w === 1280 && h === 800) || (w === 1200 && h === 800) ? "Steam Deck?" :
    /Android/i.test(ua) ? "Android" :
    /iPhone|iPad/i.test(ua) ? "iOS" :
    /Windows/i.test(ua) ? "Windows" :
    /Mac OS/i.test(ua) ? "macOS" :
    /Linux/i.test(ua) ? "Linux" : "Unknown";
  const browser =
    /Firefox\//.test(ua) ? "Firefox" :
    /Edg\//.test(ua) ? "Edge" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "browser";
  return `${platform} ${browser}${size}`;
}

export function detectCapabilities(env = globalThis) {
  const hasCanvas = !!env.canvas?.app?.renderer;
  let gamepad = false;
  try { gamepad = (env.navigator?.getGamepads?.() ?? []).some(Boolean); } catch { /* unsupported */ }
  return {
    dom:     !!env.document,
    canvas:  hasCanvas,
    input:   !!env.document,
    console: true,
    gamepad,
  };
}

/**
 * Presence bookkeeping for the gateway's directory.
 *
 * Liveness is judged by the RECEIVER's clock, never by a timestamp inside the
 * packet — a sender's clock is an unverified claim and may be wrong by hours.
 */
export function createPresenceDirectory({ ttlMs = 15_000, maxTombstones = 256 } = {}) {
  const clients = new Map();    // clientId → entry
  const tombstones = new Map(); // clientId → retired bootId

  return {
    /**
     * Idempotent upsert used for both registration and heartbeat — one code
     * path, so a heartbeat from a client the gateway never saw register (it
     * booted first, or the gateway restarted) still discovers it.
     * @returns {"new"|"refreshed"|"replaced"|"stale"}
     */
    upsert(packet, now) {
      const { clientId, bootId, seq } = packet;
      if (!clientId || !bootId) return "stale";

      const retired = tombstones.get(clientId);
      if (retired === bootId) return "stale";       // packet from a dead boot

      const prev = clients.get(clientId);
      if (prev && prev.bootId === bootId) {
        if (typeof seq === "number" && seq <= prev.seq) return "stale";  // replay/reorder
        clients.set(clientId, { ...prev, ...packet, seq, receivedAt: now });
        return "refreshed";
      }
      if (prev) {
        // Different boot for a known tab: the tab reloaded. Retire the old
        // incarnation so its in-flight packets can't resurrect it.
        this.retire(clientId, prev.bootId);
      }
      clients.set(clientId, { ...packet, seq: seq ?? 0, receivedAt: now });
      return prev ? "replaced" : "new";
    },

    retire(clientId, bootId) {
      tombstones.set(clientId, bootId);
      if (tombstones.size > maxTombstones) {
        // Bounded: drop oldest. A forgotten tombstone only risks accepting a
        // very late packet from a long-dead boot, which the sequence check and
        // the pending-request table both reject anyway.
        tombstones.delete(tombstones.keys().next().value);
      }
    },

    /** Expire clients whose last packet is older than the TTL. */
    sweep(now) {
      const expired = [];
      for (const [id, entry] of clients) {
        if (now - entry.receivedAt > ttlMs) {
          clients.delete(id);
          this.retire(id, entry.bootId);
          expired.push({ clientId: id, bootId: entry.bootId, reason: "heartbeat-ttl" });
        }
      }
      return expired;
    },

    get(clientId) { return clients.get(clientId); },
    list() { return [...clients.values()]; },
    get size() { return clients.size; },
  };
}
