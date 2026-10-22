/**
 * Which relay notice (if any) this client should show at world load.
 *
 * Pure on purpose: `startRelay()` in relay.js is impossible to unit test (it
 * touches `game`, `ui`, and WebCrypto), and this is the decision that was
 * wrong in the field. Every client used to announce on every world load, so a
 * world without a gateway popped a warning about a device that the MCP server
 * could already reach through the direct bridge — repeatedly, forever, on a
 * desktop that was working fine.
 *
 * The rule is therefore: say something only when the relay is the device's
 * ONLY route to the MCP server.
 *
 *   - Notices switched off            → stay silent (the user asked for quiet).
 *   - Direct bridge socket is open    → stay silent. The device is reachable
 *     the ordinary way; the relay adds a route, not a fact worth interrupting
 *     a world load for.
 *   - Reachable by relay only, ready  → info: name the device, so it can be
 *     matched against `list_connected_bridges` / the gateway's client list.
 *   - Relay only, no gateway yet      → warn: this is the one case where the
 *     device genuinely is not addressable, and the warning says why.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]          user setting: announce relay status at all
 * @param {boolean} [opts.gatewayReady]     gateway public keys are published in this world
 * @param {boolean} [opts.directBridgeOpen] this client's direct bridge socket is OPEN
 * @param {string}  [opts.label]            "UserName — Linux Firefox 2560x1440"
 * @returns {{level: "info"|"warn", text: string}|null} null = say nothing
 */
export function relayAnnouncement({
  enabled = true,
  gatewayReady = false,
  directBridgeOpen = false,
  label = "unknown device",
} = {}) {
  if (!enabled || directBridgeOpen) return null;

  if (gatewayReady) {
    return {
      level: "info",
      text: `Foundry MCP: this device is available to the MCP server as "${label}".`,
    };
  }

  return {
    level: "warn",
    text:
      `Foundry MCP: relay active on this device ("${label}") but no MCP gateway is running ` +
      `for this world yet. It becomes reachable once the server's gateway connects.`,
  };
}
