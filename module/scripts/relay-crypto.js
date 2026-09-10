/**
 * Relay envelope security.
 *
 * The threat is structural, not hypothetical: Foundry's module socket is a
 * BROADCAST namespace. Every connected client receives every packet, same-user
 * tabs included — verified live against v14.365. So a naive {tool, params} RPC
 * would hand every player at the table your screenshots and GM-only reads, and
 * let any of them forge a request that another browser executes.
 *
 * The constraint that shapes the solution: anything stored in a world setting
 * is readable by every client, so there is no shared secret that includes the
 * gateway and excludes players. Symmetric keys are therefore off the table.
 *
 * What saves it is that Foundry only lets GMs *write* world settings. That
 * makes a world setting a trustworthy publication channel for PUBLIC keys —
 * readable by all (fine, they're public), writable only by a GM.
 *
 *   requests   signed by the gateway   → clients verify against the pinned
 *                                        public key; forged requests rejected
 *   responses  encrypted to the gateway → only the gateway can read a result;
 *                                        screenshots stop leaking
 *
 * NOT yet covered: response authenticity. A malicious client can encrypt a
 * bogus result to the gateway's public key and race the real target. Closing
 * that needs per-client keys pinned by the GM (pairing) — see the plan
 * artifact. Recorded here so it can't be mistaken for done.
 *
 * ECDSA P-256 for signatures, ECDH P-256 + AES-GCM for encryption — all
 * WebCrypto primitives, no dependencies. `crypto.subtle` requires a secure
 * context, which the relay always has (hosted Foundry is HTTPS; localhost
 * counts as secure).
 */

const SIGN_ALGO = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" };
const ECDH_ALGO = { name: "ECDH", namedCurve: "P-256" };

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      "WebCrypto unavailable — the relay needs a secure context (https, or localhost). " +
      "A plain http:// LAN page cannot use the relay; use the legacy direct bridge there."
    );
  }
  return s;
}

const b64 = {
  encode(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

/** Gateway keypairs. Private keys never leave the gateway browser. */
export async function generateGatewayKeys() {
  const signing = await subtle().generateKey(SIGN_ALGO, true, ["sign", "verify"]);
  const sealing = await subtle().generateKey(ECDH_ALGO, true, ["deriveKey"]);
  return {
    signing,
    sealing,
    async publish() {
      return {
        sign: b64.encode(await subtle().exportKey("raw", signing.publicKey)),
        seal: b64.encode(await subtle().exportKey("raw", sealing.publicKey)),
      };
    },
  };
}

export async function importVerifyKey(rawB64) {
  return subtle().importKey("raw", b64.decode(rawB64), SIGN_ALGO, false, ["verify"]);
}

export async function importSealKey(rawB64) {
  return subtle().importKey("raw", b64.decode(rawB64), ECDH_ALGO, false, []);
}

/**
 * Canonical bytes for signing. Field order is fixed explicitly rather than
 * relying on JSON.stringify key order — a signature over a differently-ordered
 * serialisation of the same object would fail to verify for no visible reason.
 */
function canonical(envelope) {
  const { v, type, requestId, targetClientId, tool, params, nonce, issuedAt } = envelope;
  return enc.encode(JSON.stringify([v, type, requestId, targetClientId, tool, params ?? null, nonce, issuedAt]));
}

export async function signRequest(envelope, signingKey) {
  const sig = await subtle().sign(SIGN_PARAMS, signingKey, canonical(envelope));
  return { ...envelope, sig: b64.encode(sig) };
}

export async function verifyRequest(envelope, verifyKey) {
  if (!envelope?.sig) return false;
  const { sig, ...rest } = envelope;
  try {
    return await subtle().verify(SIGN_PARAMS, verifyKey, b64.decode(sig), canonical(rest));
  } catch {
    return false;
  }
}

/**
 * Seal a result to the gateway. The responder makes an ephemeral ECDH key per
 * response — so results are not linkable across responses and no long-lived
 * client secret is required before pairing exists.
 */
export async function sealToGateway(result, gatewaySealPublicKey) {
  const ephemeral = await subtle().generateKey(ECDH_ALGO, true, ["deriveKey"]);
  const shared = await subtle().deriveKey(
    { name: "ECDH", public: gatewaySealPublicKey },
    ephemeral.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, shared, enc.encode(JSON.stringify(result ?? null)));
  return {
    epk: b64.encode(await subtle().exportKey("raw", ephemeral.publicKey)),
    iv: b64.encode(iv),
    ct: b64.encode(ct),
  };
}

export async function openFromClient(sealed, gatewaySealPrivateKey) {
  const epk = await subtle().importKey("raw", b64.decode(sealed.epk), ECDH_ALGO, false, []);
  const shared = await subtle().deriveKey(
    { name: "ECDH", public: epk },
    gatewaySealPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: b64.decode(sealed.iv) },
    shared,
    b64.decode(sealed.ct),
  );
  return JSON.parse(dec.decode(pt));
}

/**
 * Replay guard. A signature proves origin, not freshness — a player who
 * captured a valid signed request could re-broadcast it forever. Bound by
 * issue time and by nonce, with the seen-set capped so it can't grow without
 * limit on a long-running client.
 */
export function createReplayGuard({ maxAgeMs = 30_000, maxSeen = 512 } = {}) {
  const seen = new Map(); // nonce → issuedAt
  return {
    check(envelope, now) {
      const { nonce, issuedAt } = envelope ?? {};
      if (!nonce || typeof issuedAt !== "number") return { ok: false, reason: "missing-nonce" };
      if (Math.abs(now - issuedAt) > maxAgeMs) return { ok: false, reason: "stale-or-skewed" };
      if (seen.has(nonce)) return { ok: false, reason: "replay" };
      seen.set(nonce, issuedAt);
      if (seen.size > maxSeen) seen.delete(seen.keys().next().value);
      return { ok: true };
    },
  };
}
