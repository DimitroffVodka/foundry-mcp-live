/**
 * MCP session eviction policy. Each session holds a full McpServer with every
 * tool registered, and a client that vanishes without sending DELETE never
 * fires transport.onclose — so without this the sessions Map only grows.
 */

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX = 64;

/**
 * Which sessions to close: every one idle for `idleMs`, then the least
 * recently active until `room` new sessions fit under `max`.
 *
 * @param {Map<string, {lastActive: number}>} sessions
 * @returns {string[]} session ids
 */
export function sessionsToEvict(sessions, { now = Date.now(), idleMs = SESSION_IDLE_MS, max = SESSION_MAX, room = 0 } = {}) {
  const idle = [], live = [];
  for (const [id, s] of sessions) (now - s.lastActive >= idleMs ? idle : live).push([id, s.lastActive]);
  live.sort((a, b) => a[1] - b[1]);
  const over = Math.max(0, live.length + room - max);
  return [...idle, ...live.slice(0, over)].map(([id]) => id);
}
