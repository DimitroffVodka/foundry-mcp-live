/**
 * Foundry-mediated relay — browser side.
 *
 * Why this exists: the direct bridge requires every execution target to be a
 * direct network peer of the MCP server. A remote device can never be one — an
 * https page cannot open ws:// to a private IP (mixed content, hard
 * SecurityError) and `localhost` on that device means that device. But every
 * client already holds an authenticated TLS socket to Foundry, so we relay
 * through it instead. See the gateway-relay-plan artifact.
 *
 * Two roles, one file, because a client can be either:
 *
 *   TARGET   every client. Listens for requests addressed to its clientId,
 *            verifies the gateway's signature, runs the existing handler, and
 *            seals the result so only the gateway can read it.
 *   GATEWAY  one managed browser on the MCP machine. Owns no secrets — Node
 *            holds the keys and hands it pre-signed envelopes to broadcast,
 *            and opens the sealed replies. This page is a dumb pipe by design:
 *            it runs unattended, so a compromise of it must not yield the
 *            ability to sign requests or decrypt results.
 *
 * Transport is Foundry's package socket, which is a BROADCAST namespace: every
 * client sees every packet, so addressing is by convention and security is by
 * cryptography, never by the transport.
 */

import {
  newId,
  resolveClientId,
  detectCapabilities,
  createPresenceDirectory,
  describeClient,
} from "./relay-identity.js";
import {
  importVerifyKey,
  importSealKey,
  verifyRequest,
  sealToGateway,
  createReplayGuard,
} from "./relay-crypto.js";

const MODULE_ID = "foundry-mcp-live";
const CHANNEL = `module.${MODULE_ID}`;
const PROTOCOL = 1;

const HEARTBEAT_MS = 5_000;
const PRESENCE_TTL_MS = 15_000;
/** Sealed results above this are refused rather than broadcast to every client. */
const MAX_RESULT_BYTES = 512 * 1024;

let state = null;

/**
 * @param {object} opts
 * @param {(tool: string, params: object) => Promise<any>} opts.dispatch
 *   Runs a tool in this browser. Injected rather than imported so relay.js has
 *   no dependency on bridge.js's handler table (and no import cycle).
 */
export function initRelay({ dispatch }) {
  if (state) return state;

  const clientId = resolveClientId();
  const bootId = newId("boot");

  state = {
    clientId,
    bootId,
    seq: 0,
    dispatch,
    isGateway: false,
    directory: createPresenceDirectory({ ttlMs: PRESENCE_TTL_MS }),
    replay: createReplayGuard(),
    verifyKey: null,
    sealKey: null,
    pending: new Map(),      // requestId → {resolve, reject, timer, expectSource}
    heartbeatTimer: null,
  };

  game.socket.on(CHANNEL, (packet) => { onPacket(packet).catch(reportError); });

  Hooks.on("closeGame", () => teardownRelay());

  return state;
}

function reportError(err) {
  console.error(`${MODULE_ID} | relay:`, err);
}

function nextSeq() { return ++state.seq; }

function broadcast(packet) {
  game.socket.emit(CHANNEL, packet);
}

// ---------------------------------------------------------------------------
// Gateway public keys
// ---------------------------------------------------------------------------
// Published in a world setting. That is a trustworthy channel for PUBLIC keys
// precisely because Foundry only lets GMs write world settings — every client
// can read it (fine, they are public) but a player cannot substitute their own
// key and start issuing signed requests.

async function loadGatewayKeys() {
  let published;
  try { published = game.settings.get(MODULE_ID, "relayGatewayKeys"); }
  catch { return false; }
  if (!published) return false;

  let parsed;
  try { parsed = typeof published === "string" ? JSON.parse(published) : published; }
  catch { return false; }
  if (!parsed?.sign || !parsed?.seal) return false;

  try {
    state.verifyKey = await importVerifyKey(parsed.sign);
    state.sealKey = await importSealKey(parsed.seal);
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

function presencePacket() {
  return {
    v: PROTOCOL,
    type: "presence",
    clientId: state.clientId,
    bootId: state.bootId,
    seq: nextSeq(),
    userId: game.user?.id ?? "",
    userName: game.user?.name ?? "",
    isGM: !!game.user?.isGM,
    label: `${game.user?.name ?? "?"} — ${describeClient()}`,
    capabilities: detectCapabilities(),
    worldId: game.world?.id ?? "",
  };
}

function startHeartbeat() {
  if (state.heartbeatTimer) return;
  broadcast(presencePacket());
  state.heartbeatTimer = setInterval(() => {
    broadcast(presencePacket());
    if (state.isGateway) {
      for (const gone of state.directory.sweep(Date.now())) {
        console.log(`${MODULE_ID} | relay: ${gone.clientId} expired (${gone.reason})`);
      }
    }
  }, HEARTBEAT_MS);
}

// ---------------------------------------------------------------------------
// Packet handling
// ---------------------------------------------------------------------------

async function onPacket(packet) {
  if (!packet || packet.v !== PROTOCOL) return;

  switch (packet.type) {
    case "presence":
      // Only the gateway keeps a directory; targets ignore each other.
      if (state.isGateway) state.directory.upsert(packet, Date.now());
      return;

    case "discover":
      // A gateway that just booted asks everyone to re-announce rather than
      // waiting a full heartbeat interval to discover clients that started
      // before it did.
      if (!state.isGateway) broadcast(presencePacket());
      return;

    case "request":
      return onRequest(packet);

    case "response":
      if (state.isGateway) onResponse(packet);
      return;
  }
}

/** TARGET role: execute a signed request addressed to this client. */
async function onRequest(packet) {
  if (packet.targetClientId !== state.clientId) return;   // addressed elsewhere

  if (!state.verifyKey || !state.sealKey) {
    const loaded = await loadGatewayKeys();
    if (!loaded) return respondError(packet, "No gateway keys published in this world.");
  }

  // Signature first: everything downstream trusts these fields.
  //
  // A failure here is ambiguous, and the benign case is common: the gateway
  // generates a fresh keypair every time the MCP server restarts, so a client
  // that has been open across a restart still holds the previous public key and
  // rejects every request from the new gateway. Silently, and forever — the
  // client keeps heartbeating so it looks perfectly healthy in the directory
  // while every call to it times out.
  //
  // So on failure, re-read the published key once and retry before concluding
  // forgery. A real forger simply fails twice.
  if (!(await verifyRequest(packet, state.verifyKey))) {
    const rotated = await loadGatewayKeys();
    if (!rotated || !(await verifyRequest(packet, state.verifyKey))) {
      console.warn(`${MODULE_ID} | relay: rejected request ${packet.requestId} — bad signature`);
      return; // stay silent; answering tells a forger their probe landed
    }
    console.log(`${MODULE_ID} | relay: gateway key rotated — reloaded and accepted`);
  }

  const fresh = state.replay.check(packet, Date.now());
  if (!fresh.ok) {
    console.warn(`${MODULE_ID} | relay: rejected request ${packet.requestId} — ${fresh.reason}`);
    return;
  }

  try {
    const result = await state.dispatch(packet.tool, packet.params ?? {});
    const sealed = await sealToGateway(result, state.sealKey);
    const size = JSON.stringify(sealed).length;
    if (size > MAX_RESULT_BYTES) {
      // Every client pays for a broadcast, so an oversized result is refused
      // rather than flooding the world's socket. Chunking is the follow-up.
      return respondError(packet, `Result too large to relay (${size} bytes > ${MAX_RESULT_BYTES}).`);
    }
    broadcast({
      v: PROTOCOL,
      type: "response",
      requestId: packet.requestId,
      sourceClientId: state.clientId,
      bootId: state.bootId,
      sealed,
    });
  } catch (err) {
    respondError(packet, err?.message || String(err));
  }
}

/**
 * Errors travel in the clear. They are generated by our own handler, carry no
 * world data, and a failure the gateway cannot read is worse than a failure a
 * player can see.
 */
function respondError(packet, message) {
  broadcast({
    v: PROTOCOL,
    type: "response",
    requestId: packet.requestId,
    sourceClientId: state.clientId,
    bootId: state.bootId,
    error: message,
  });
}

/** GATEWAY role: match a reply to its pending request. */
function onResponse(packet) {
  const pending = state.pending.get(packet.requestId);
  if (!pending) return;                                  // unknown or already settled
  if (packet.sourceClientId !== pending.expectSource) {
    // Someone other than the addressed target answered. Until per-client keys
    // exist this is the only defence against a forged reply, so it is a hard
    // reject rather than a warning.
    console.warn(`${MODULE_ID} | relay: dropped reply to ${packet.requestId} from unexpected ${packet.sourceClientId}`);
    return;
  }
  state.pending.delete(packet.requestId);
  clearTimeout(pending.timer);
  pending.resolve(packet);
}

// ---------------------------------------------------------------------------
// Gateway API — driven from Node over CDP
// ---------------------------------------------------------------------------

/** Drop cached gateway keys so the next packet re-reads the published pair. */
export function notifyGatewayKeysRotated() {
  if (!state) return;
  state.verifyKey = null;
  state.sealKey = null;
}

export function becomeGateway() {
  state.isGateway = true;
  broadcast({ v: PROTOCOL, type: "discover", clientId: state.clientId, bootId: state.bootId });
  return { clientId: state.clientId, bootId: state.bootId };
}

/** Publish the server's public keys. Requires this client to be a GM. */
export async function publishGatewayKeys(publicKeys) {
  await game.settings.set(MODULE_ID, "relayGatewayKeys", JSON.stringify(publicKeys));
  return true;
}

export function listRelayClients() {
  return state.directory.list().map((c) => ({
    clientId: c.clientId,
    label: c.label,
    userName: c.userName,
    userId: c.userId,
    isGM: c.isGM,
    capabilities: c.capabilities,
    ageMs: Date.now() - c.receivedAt,
  }));
}

/**
 * Broadcast a pre-signed envelope and await the sealed reply.
 * Node signs; this page never holds a key.
 */
export function sendSignedRequest(envelope, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(envelope.requestId);
      reject(new Error(`Relay request to ${envelope.targetClientId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    state.pending.set(envelope.requestId, {
      resolve, reject, timer, expectSource: envelope.targetClientId,
    });
    broadcast(envelope);
  });
}

export function teardownRelay() {
  if (!state) return;
  clearInterval(state.heartbeatTimer);
  for (const p of state.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Relay shutting down"));
  }
  state.pending.clear();
  state = null;
}

export function startRelay() {
  startHeartbeat();

  // The direct bridge pops a toast when its socket opens. The relay showed
  // nothing at all, so on a device that can only ever be relayed (a Deck, a
  // tablet) there was no signal it was working — the absence of the familiar
  // toast read as "not connected". Announce it, and name the device so it can
  // be matched against the target list.
  const label = `${game.user?.name ?? "?"} — ${describeClient()}`;
  loadGatewayKeys().then((ready) => {
    if (ready) {
      ui.notifications?.info(`Foundry MCP: this device is available to the MCP server as "${label}".`);
    } else {
      ui.notifications?.warn(
        `Foundry MCP: relay active on this device ("${label}") but no MCP gateway is running for this world yet. ` +
        `It becomes reachable once the server's gateway connects.`
      );
    }
  }).catch(() => {});

  return { clientId: state.clientId, bootId: state.bootId };
}
