/**
 * Holder for the live relay gateway.
 *
 * Exists to keep `foundry-rpc.js` from importing `relay-gateway.js` directly:
 * the gateway pulls in puppeteer-core and the module's crypto, and the RPC
 * layer is imported by every tool. server.js sets the instance once at startup;
 * everything else asks for it here.
 */
import { log } from "./log.js";

let gateway = null;

export function setRelayGateway(instance) { gateway = instance; }
export function getRelayGateway() { return gateway; }
export function relayAvailable() { return !!gateway?.isRunning; }

/**
 * Cached client directory. `requestFoundry` consults this on every miss of the
 * direct bridge, and each lookup is a CDP round trip into the gateway page —
 * far too slow to repeat per call. Presence heartbeats are 5s, so a 2s cache
 * cannot hide a client for meaningfully longer than the protocol already does.
 */
const CACHE_MS = 2_000;
let cache = { at: 0, clients: [] };

export async function relayClients({ force = false } = {}) {
  if (!relayAvailable()) return [];
  const now = Date.now();
  if (!force && now - cache.at < CACHE_MS) return cache.clients;
  try {
    const clients = await gateway.listClients();
    cache = { at: now, clients, error: null };
    return clients;
  } catch (err) {
    // Do NOT keep serving the last good snapshot. A frozen directory is
    // indistinguishable from a live one at the call site — devices that have
    // since joined stay invisible and devices that left look present, and the
    // caller has no way to tell. A read failure is information; hiding it
    // behind stale data turns a diagnosable fault into a mystery.
    cache = { at: now, clients: [], error: err?.message || String(err) };
    log(`WARNING: relay directory read failed — ${cache.error}`);
    return [];
  }
}

/** Why the last directory read failed, if it did. Surfaced by the tools. */
export function relayDirectoryError() { return cache.error ?? null; }

/**
 * Resolve a user-supplied target to a relay client.
 *
 * Accepts, in order of precision: exact clientId, exact device label, exact
 * Foundry user name. User name is last and only when unambiguous — it is the
 * one that collides, since a desktop and a Steam Deck signed in as the same GM
 * share it. That collision is precisely what the old userId-keyed registry got
 * wrong, so resolving it silently would reintroduce the bug.
 */
export function resolveRelayTarget(clients, target) {
  if (!target) return null;
  const byId = clients.find((c) => c.clientId === target);
  if (byId) return byId;
  const byLabel = clients.filter((c) => c.label === target);
  if (byLabel.length === 1) return byLabel[0];
  const byUser = clients.filter((c) => c.userName === target);
  if (byUser.length === 1) return byUser[0];
  if (byUser.length > 1) {
    throw new Error(
      `"${target}" matches ${byUser.length} relay clients — address one by clientId or device label. ` +
      `Candidates: ${byUser.map((c) => `${c.clientId} (${c.label})`).join(", ")}`
    );
  }
  return null;
}
