/**
 * Foundry bridge management.
 *
 * Owns:
 *   - the `bridges` Map (userId → bridge metadata + socket)
 *   - hello-handshake handling
 *   - `routeBridge(targetUser)` resolution
 *   - `reconnectWaiters` — promises that resolve when a specific user's bridge
 *     announces itself via hello (used by `reload_foundry`)
 *
 * Each bridge identifies itself with a `{ type: "hello", userId, userName,
 * isGM }` frame on connect. Server tracks bridges by userId so MCP tool calls
 * can route to a specific Foundry user via the optional `targetUser` param.
 *
 * Backward compat: bridges that don't send a hello within HELLO_DEADLINE_MS
 * are registered under the `__legacy__` key as a default GM. Lets old bridge
 * installs keep working until they're upgraded.
 */
import { WebSocketServer } from "ws";
import { WS_PORT, WS_HOST, WS_HOST_IS_LOOPBACK, WS_ALLOWED_ORIGINS, HELLO_DEADLINE_MS, HEARTBEAT_INTERVAL_MS, WS_TOKEN, WS_TOKEN_NOTICES, SERVER_VERSION, SERVER_ROOT, PROTOCOL_VERSION } from "./config.js";
import { codedError } from "./errors.js";
import { log }                        from "./log.js";
import { pendingRequests }            from "./foundry-rpc.js";

export const bridges          = new Map();   // userId → { socket, userId, userName, isGM, connectedAt }
export const lastSeenBridges  = new Map();   // userId → last identified bridge metadata (without socket)
export const reconnectWaiters = new Map();   // userId → { resolve, reject, timer }
const pendingHello            = new WeakMap();// socket → setTimeout id

/**
 * Resolve `targetUser` to a connected bridge.
 *
 * @param {string|undefined} targetUser
 *   - undefined / "GM" / "self" → first GM bridge (single-GM constraint)
 *   - "<userName>"              → bridge whose userName matches exactly
 *   - "<userName>@<host>"       → disambiguator when two bridges share a name
 *                                 (matches the `host` reported in the hello
 *                                 frame, e.g. "Gamemaster@foundry.example.com")
 *   - "<userId>"                → bridge whose userId matches exactly
 * @returns {{socket: WebSocket, userId: string, userName: string, isGM: boolean, host: string, connectedAt: number}}
 * @throws if no matching bridge is connected
 */
export function routeBridge(targetUser) {
  if (!targetUser || targetUser === "GM" || targetUser === "self") {
    // Prefer a real (hello-identified) GM over the legacy fallback bucket
    // — otherwise a transient `__legacy__` entry that registered first
    // could win the default route even when a real GM is also connected.
    // Also skip "Bridge" users — they're MCP plumbing, not the actual GM.
    for (const b of bridges.values()) {
      if (b.isGM && b.userId !== "__legacy__" && b.userName !== "Bridge") return b;
    }
    // Fall back to Bridge user if no real GM is available.
    for (const b of bridges.values()) {
      if (b.isGM && b.userId !== "__legacy__") return b;
    }
    const legacy = bridges.get("__legacy__");
    if (legacy?.isGM) return legacy;
    throw codedError("FML-0001", "No GM bridge connected.");
  }
  // 1. Exact userName match (back-compat, most common).
  // 2. "userName@host" disambiguator.
  // 3. Exact userId match (unambiguous escape hatch).
  for (const b of bridges.values()) {
    if (b.userId === "__legacy__") continue;
    if (b.userName === targetUser) return b;
    if (b.host && `${b.userName}@${b.host}` === targetUser) return b;
    if (b.userId === targetUser) return b;
  }
  const known = [...bridges.values()]
    .filter(b => b.userId !== "__legacy__")
    .map(b => b.host ? `${b.userName}@${b.host}` : b.userName)
    .join(", ");
  const hasLegacy = bridges.has("__legacy__");
  const suffix = hasLegacy
    ? " (a legacy bridge is also connected — upgrade the bridge module to address it by name)"
    : "";
  throw codedError(
    "FML-0002",
    `No bridge connected for "${targetUser}". Connected: ${known || "(none)"}.${suffix}`
  );
}

/**
 * Is this peer address this machine?
 *
 * `ws` reports IPv4 loopback as `127.0.0.1` and IPv6 as `::1`; when the server
 * is bound to `::`, IPv4 peers arrive v4-mapped as `::ffff:127.0.0.1`. All
 * three mean the same thing — a process running as this user.
 */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? "").trim().toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || a === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * May this peer skip the bridge token?
 *
 * The token exists to protect the port that `FOUNDRY_WS_HOST` opens to the
 * LAN. A client on the loopback interface is already running as this user and
 * gains nothing by authenticating — which is why a local world should never
 * have needed a token pasted into its settings.
 *
 * But "arrived on loopback" is not by itself "trusted": CORS does not apply to
 * WebSockets, so any page the user happens to visit can open a socket to
 * 127.0.0.1 and try to register as a GM bridge. The browser's `Origin` header
 * is the discriminator — page JS cannot forge it — so a loopback peer is
 * trusted only when its origin is a Foundry one.
 *
 * Rules, in order:
 *   - a proxied request is never local: an `X-Forwarded-*` header means the
 *     loopback address belongs to the proxy, not to the peer behind it
 *   - a non-loopback peer is never local, whatever it claims as its origin
 *   - no `Origin` at all → not a browser (a script, a test harness); on
 *     loopback that is already user-privileged, so it is allowed
 *   - `Origin: null` → sandboxed iframe or `file://`, which a hostile page can
 *     arrange deliberately, so it is refused
 *   - an explicitly allowlisted origin is allowed
 *   - otherwise the origin must itself be a loopback URL — the Foundry client
 *     served from localhost on any port
 *
 * @returns {boolean} true when the token requirement may be skipped
 */
export function isTrustedLocalPeer({ remoteAddress, origin, forwarded = false, allowedOrigins = [] } = {}) {
  if (forwarded) return false;
  if (!isLoopbackAddress(remoteAddress)) return false;

  const normalize = (v) => String(v ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const raw = normalize(origin);
  if (!raw) return true;
  if (raw === "null") return false;
  if (allowedOrigins.some(allowed => normalize(allowed) === raw)) return true;

  try {
    // IPv6 hostnames arrive bracketed ("[::1]"); strip them before matching.
    return isLoopbackAddress(new URL(raw).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * Identify a hello frame that has NOT passed the token check yet.
 *
 * Every field here is attacker-controlled — the peer failed auth, so it is
 * whatever reached the port. Control characters are stripped and each field
 * capped so a rejected peer cannot forge extra log lines or flood the log
 * through a value we echo back into it.
 *
 * @param {object} [msg] a parsed `hello` frame
 * @returns {string} e.g. `Gamemaster @ http://localhost:30000 (world "crow-test")`
 */
export function describeUnauthedHello(msg = {}) {
  const clean = (v) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 64);
  const name  = clean(msg.userName) || "unidentified client";
  const where = clean(msg.origin) || clean(msg.host);
  const world = clean(msg.worldId);
  return `${name}${where ? ` @ ${where}` : ""}${world ? ` (world "${world}")` : ""}`;
}

/**
 * Why a hello frame's token was rejected, in operator-actionable terms.
 *
 * Split out from the reject path because three failures that are identical
 * from the socket's point of view need opposite advice: nothing was sent (the
 * world setting was never filled in), a paste picked up whitespace, or the
 * value is genuinely different. The old "invalid or missing token" line sent
 * operators to re-check a token they had never set in the first place.
 *
 * Lengths, never values — enough to spot a truncated or padded paste without
 * writing the token itself into the log.
 *
 * @param {unknown} sent     the `token` field as it arrived
 * @param {string}  expected the configured WS token
 * @returns {string}
 */
export function explainTokenRejection(sent, expected) {
  if (sent === undefined || sent === null || sent === "") {
    return `no token sent — this world's "MCP bridge token" setting and the client's localStorage.mcpBridgeToken are both empty`;
  }
  if (typeof sent !== "string") {
    return `token field was ${typeof sent}, expected a string`;
  }
  if (sent.trim() === String(expected ?? "").trim()) {
    return `token matches apart from surrounding whitespace (sent ${sent.length} chars, expected ${expected.length}) `
      + `— check for a trailing newline or wrapping quotes in the server env file`;
  }
  return `token does not match (sent ${sent.length} chars, expected ${expected.length})`;
}

/**
 * Start the WebSocket server that Foundry bridges connect to. Call once
 * from `server.js` startup. Returns the WebSocketServer instance for tests
 * or graceful shutdown handlers.
 */
export function startBridgeServer() {
  const wss = new WebSocketServer({ port: WS_PORT, host: WS_HOST });

  // Log success only after the port is actually bound. WebSocketServer's
  // constructor returns synchronously but the bind is async — logging
  // here would print "listening on..." even when the bind ultimately fails
  // with EADDRINUSE. Wait for the real `listening` event instead, and
  // surface bind errors clearly with actionable hints.
  wss.on("listening", () => {
    log(`WebSocket bridge listening on ws://${WS_HOST}:${WS_PORT}`);
    // Anything the token store wants the operator to know (a token was
    // generated for them, or could not be persisted). Collected at import
    // time; printed here, where there is a log to print to.
    for (const notice of WS_TOKEN_NOTICES) log(notice);
    // State the auth posture every start, both ways. The token comes from the
    // environment, which is read once at process start — so an env file edited
    // days ago arms the gate on the next restart with nothing marking the
    // moment, and the only symptom is every client reconnect-looping on a 1008
    // that is invisible from the server side. One line here makes "auth is on"
    // answerable from the log instead of from a browser console.
    log(WS_TOKEN
      ? `Bridge auth: REQUIRED for clients from another machine — a Foundry client on this machine connects `
        + `without one, and a GM client publishes the token into its world so other devices pick it up `
        + `automatically. No manual setup needed.`
        + (WS_ALLOWED_ORIGINS.length ? ` Also trusted locally: ${WS_ALLOWED_ORIGINS.join(", ")}.` : "")
      : `Bridge auth: OFF — no FOUNDRY_WS_TOKEN or BRIDGE_TOKEN set, every client that reaches the port is trusted.`);
    // Binding off-loopback is the deliberate "let a second device connect"
    // move. Doing it without a token means anything that can route to this
    // port can register as a GM bridge and drive the world — including the
    // eval/write tools when those env gates are on. Loud, not fatal: the
    // operator asked for the wider bind, so don't refuse to start.
    if (!WS_HOST_IS_LOOPBACK && !WS_TOKEN) {
      log(`WARNING: bridge is bound to ${WS_HOST} (reachable off this machine) with no token set. `
        + `Any host that can reach ${WS_HOST}:${WS_PORT} can register as a GM bridge. `
        + `Set FOUNDRY_WS_TOKEN and put the same value in each browser's localStorage.mcpBridgeToken.`);
    }
  });
  wss.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      log(`ERROR: WebSocket port ${WS_PORT} is already in use. Another foundry-mcp server is probably running. Kill it (netstat -ano | findstr :${WS_PORT} → taskkill /PID <pid> /F) and restart.`);
    } else {
      log(`ERROR: WebSocket server failed: ${err?.message || err}`);
    }
    // Re-throw so the process exits with a non-zero code rather than
    // limping along with a half-initialized bridge.
    throw err;
  });

  wss.on("connection", (socket, req) => {
    // Decide the trust level once, from the handshake — the HTTP upgrade
    // request is the only place the peer address and Origin are available, and
    // both are gone by the time the hello frame arrives.
    const trustedLocal = isTrustedLocalPeer({
      remoteAddress:  req?.socket?.remoteAddress,
      origin:         req?.headers?.origin,
      forwarded:      Boolean(req?.headers?.["x-forwarded-for"] || req?.headers?.["x-forwarded-host"] || req?.headers?.forwarded),
      allowedOrigins: WS_ALLOWED_ORIGINS,
    });
    const tokenRequired = Boolean(WS_TOKEN) && !trustedLocal;
    log("Foundry bridge socket opened (awaiting hello)");

    // Heartbeat liveness (see the interval below). A fresh socket starts
    // alive; every pong from the peer re-arms it. If a socket goes half-open
    // (peer's TCP is dead but never sent a FIN, so no `close` fires), it stops
    // ponging and the interval terminates it on the next sweep.
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });

    // Schedule a deadline for the `hello` frame. If it doesn't arrive, the
    // bridge is from a pre-multi-user version — register as legacy GM so it
    // still works (only when no bridge token is set; otherwise legacy
    // fallback bypasses auth so we close the socket instead).
    const helloTimer = setTimeout(() => {
      pendingHello.delete(socket);
      if (tokenRequired) {
        log("Bridge missed hello and a bridge token is required for this peer — closing socket");
        socket.close(1008, "auth required");
        return;
      }
      bridges.set("__legacy__", {
        socket,
        userId:      "__legacy__",
        userName:    "Unknown (legacy)",
        isGM:        true,
        connectedAt: Date.now(),
      });
      log("Bridge legacy-registered (no hello within 500ms) — treating as GM");
    }, HELLO_DEADLINE_MS);
    pendingHello.set(socket, helloTimer);

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Identity handshake — register the bridge keyed by userId.
      if (msg.type === "hello") {
        const t = pendingHello.get(socket);
        if (t) { clearTimeout(t); pendingHello.delete(socket); }

        if (tokenRequired && msg.token !== WS_TOKEN) {
          log(`Bridge hello rejected from ${describeUnauthedHello(msg)}: ${explainTokenRejection(msg.token, WS_TOKEN)}`);
          socket.close(1008, "auth failed");
          return;
        }
        // A local client whose world still carries an old token is fine — it
        // was never being checked — but say so once, because a stale value in
        // a world setting is exactly what breaks that world on a remote
        // client later.
        if (WS_TOKEN && trustedLocal && msg.token && msg.token !== WS_TOKEN) {
          log(`Note: local bridge sent a token that does not match FOUNDRY_WS_TOKEN — ignored (local clients are not `
            + `token-checked), but this world's "MCP bridge token" setting is stale and will fail from another machine.`);
        }

        const { userId, userName, isGM, host, origin, worldId, systemId, foundryVersion } = msg;
        if (!userId || !userName) {
          // Redact before echoing the frame: this line is downstream of the
          // token check, so a frame that reaches it carries the *correct*
          // token — stringifying it verbatim wrote the real secret to the log.
          const safe = { ...msg, token: msg.token ? "[redacted]" : undefined };
          log(`Bridge sent malformed hello, ignoring: ${JSON.stringify(safe)}`);
          return;
        }

        // If this socket was already legacy-registered because hello arrived
        // after the deadline, evict the legacy entry — the real identity
        // supersedes it. (Fixes the "legacyBridgeConnected: true" cosmetic
        // bug where the stale entry stuck around after the real hello.)
        const legacy = bridges.get("__legacy__");
        if (legacy && legacy.socket === socket) {
          bridges.delete("__legacy__");
          log("Bridge promoted from legacy → identified");
        }

        const bridge = {
          socket,
          userId,
          userName,
          isGM: !!isGM,
          host: host || "",
          origin: origin || "",
          worldId: worldId || "",
          systemId: systemId || "",
          foundryVersion: foundryVersion || "",
          connectedAt: Date.now(),
        };
        bridges.set(userId, bridge);
        lastSeenBridges.set(userId, {
          ...bridge,
          socket: undefined,
          disconnectedAt: null,
        });
        const hostStr = host ? ` @ ${host}` : "";
        // Record how the peer got in. With a token set, "which of my bridges
        // is actually authenticating?" is otherwise unanswerable from the log.
        const trustStr = !WS_TOKEN ? "" : trustedLocal ? " [local, no token required]" : " [token accepted]";
        log(`Bridge registered: ${userName}${hostStr} (${userId}) [${isGM ? "GM" : "player"}]${trustStr}`);

        // Announce our version back to the module. The module compares this
        // against its own and warns the user (in the Foundry UI) if the server
        // is out of date — the only update signal the headless server has.
        // A module talking to an OLDER server gets no hello-ack at all, which
        // the module also treats as "server outdated".
        try {
          socket.send(JSON.stringify({
            type: "hello-ack",
            serverVersion: SERVER_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            // Lets the out-of-date dialog print a `cd` that actually works
            // rather than guessing at ~/foundry-mcp-live.
            serverRoot: SERVER_ROOT,
            // Hand the token to clients that are already trusted without it,
            // so the GM never has to transcribe a secret: the module stores it
            // in the world setting, and Foundry serves that to every other
            // client in the world — including the phone that DOES need it.
            //
            // Three conditions, all necessary. Trusted-local, or we would be
            // handing the secret to the very clients it exists to keep out.
            // GM, because only a GM can write a world setting — sending it to
            // a player leaks it for nothing. And a token must exist at all.
            ...(WS_TOKEN && trustedLocal && isGM ? { bridgeToken: WS_TOKEN } : {}),
          }));
        } catch { /* socket may have closed; ignore */ }

        // If reload_foundry (or anyone else) is waiting for this user to
        // (re)connect, resolve their promise.
        const waiter = reconnectWaiters.get(userId);
        if (waiter) {
          reconnectWaiters.delete(userId);
          clearTimeout(waiter.timer);
          waiter.resolve(bridge);
        }
        return;
      }

      // Normal request reply — match by request id.
      const pending = pendingRequests.get(msg.id);
      if (!pending) return;

      pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) pending.reject(new Error(msg.error));
      else           pending.resolve(msg.data);
    });

    socket.on("close", () => {
      // Clear any pending hello deadline.
      const t = pendingHello.get(socket);
      if (t) { clearTimeout(t); pendingHello.delete(socket); }

      // Find which bridges entry holds this socket and remove it.
      let removed = null;
      for (const [key, b] of bridges) {
        if (b.socket === socket) { removed = b; bridges.delete(key); break; }
      }
      if (removed) {
        lastSeenBridges.set(removed.userId, {
          ...removed,
          socket: undefined,
          disconnectedAt: Date.now(),
        });
        log(`Bridge closed: ${removed.userName}`);
      }
      else         log("Unidentified bridge socket closed");

      // Reject pending requests waiting on this specific socket.
      for (const [id, pending] of pendingRequests) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error(
          `Bridge for "${removed?.userName ?? "unknown"}" disconnected`
        ));
        pendingRequests.delete(id);
      }
    });
  });

  // Ping/pong heartbeat — reap half-open sockets that never fired `close`.
  //
  // A bridge is otherwise removed ONLY on the socket's `close` event. If the
  // peer goes half-open (its TCP dies without a FIN — laptop sleep, NAT idle
  // timeout, network drop), `close` never fires and the dead bridge lingers in
  // `bridges` indefinitely, invisible-yet-registered. `socket.terminate()`
  // synthesizes the `close` handler above, which removes the bridge and lets
  // the module's client-side reconnect kick in.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        log("Bridge failed heartbeat (no pong) — terminating half-open socket");
        socket.terminate();          // fires `close` → bridge removed, client reconnects
        continue;
      }
      socket.isAlive = false;        // cleared here, re-armed by the "pong" handler
      try { socket.ping(); } catch { /* socket may be mid-teardown; ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't let the heartbeat timer keep the process alive on its own.
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
