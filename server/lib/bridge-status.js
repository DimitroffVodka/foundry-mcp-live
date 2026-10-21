function bridgeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return [...value.values()];
  return [];
}

export function normalizeFoundryOrigin(value) {
  if (!value || typeof value !== "string") return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function classifyBridgeStatus({ bridges = [], probes = [] }) {
  if (bridges.length > 0) {
    return { classification: "bridge-connected" };
  }
  const reachable = probes.filter(p => p.reachable);
  if (reachable.some(p => Number(p.users) > 0)) {
    return { classification: "foundry-up-no-bridge" };
  }
  if (reachable.length > 0) {
    return { classification: "foundry-up-no-users" };
  }
  if (probes.length > 0) {
    return { classification: "foundry-down" };
  }
  return { classification: "unknown" };
}

async function probeFoundry(origin, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/api/status`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { origin, reachable: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const status = await response.json();
    return {
      origin,
      reachable: true,
      active: status.active ?? null,
      users: status.users ?? null,
      world: status.world ?? null,
      system: status.system ?? null,
      systemVersion: status.systemVersion ?? null,
      foundryVersion: status.version ?? null,
      uptime: status.uptime ?? null,
    };
  } catch (err) {
    return {
      origin,
      reachable: false,
      error: err?.name === "AbortError" ? `Probe timed out after ${timeoutMs}ms` : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnoseBridgeStatus({
  bridges,
  lastSeenBridges,
  configuredOrigins = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
}) {
  const connected = bridgeValues(bridges)
    .filter(b => b.userId !== "__legacy__")
    .map(b => ({
      userId: b.userId,
      userName: b.userName,
      isGM: !!b.isGM,
      host: b.host || "",
      origin: normalizeFoundryOrigin(b.origin || b.host),
      worldId: b.worldId || null,
      systemId: b.systemId || null,
      foundryVersion: b.foundryVersion || null,
      ...b.fingerprint,
      connectedAt: b.connectedAt ? new Date(b.connectedAt).toISOString() : null,
    }));

  const lastSeen = bridgeValues(lastSeenBridges)
    .filter(b => b.userId !== "__legacy__")
    .map(b => ({
      userId: b.userId,
      userName: b.userName,
      isGM: !!b.isGM,
      host: b.host || "",
      origin: normalizeFoundryOrigin(b.origin || b.host),
      worldId: b.worldId || null,
      systemId: b.systemId || null,
      foundryVersion: b.foundryVersion || null,
      ...b.fingerprint,
      connectedAt: b.connectedAt ? new Date(b.connectedAt).toISOString() : null,
      disconnectedAt: b.disconnectedAt ? new Date(b.disconnectedAt).toISOString() : null,
    }));

  const origins = new Set();
  for (const entry of [...connected, ...lastSeen]) {
    if (entry.origin) origins.add(entry.origin);
  }
  for (const value of configuredOrigins) {
    const origin = normalizeFoundryOrigin(value);
    if (origin) origins.add(origin);
  }

  const probes = typeof fetchImpl === "function"
    ? await Promise.all([...origins].map(origin => probeFoundry(origin, fetchImpl, timeoutMs)))
    : [];
  const { classification } = classifyBridgeStatus({ bridges: connected, probes });

  return {
    classification,
    bridges: connected,
    lastSeenBridges: lastSeen,
    probes,
  };
}
