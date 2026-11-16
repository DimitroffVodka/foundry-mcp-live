/**
 * Auto-connect decision — extracted from bridge.js's `ready` hook so the branch
 * can be unit-tested under Node without a Foundry client (bridge.js itself
 * touches `game`/`Hooks` at module scope and can't be imported outside the
 * browser). Pure: the caller reads the two settings and passes them as booleans.
 *
 *   optedIn  = game.settings.get(MODULE_ID, "autoConnect")  // client setting, default on for GMs only
 *   headless = !!game.settings.get("core", "noCanvas")      // dedicated headless bridge client
 *
 * The headless (no-canvas) bridge client always connects, even when a GM has
 * turned auto-connect off for their own interactive play client — that's how
 * the MCP tools stay available regardless of any one client's preference.
 *
 * @param {{optedIn?: boolean, headless?: boolean}} [settings]
 * @returns {boolean} whether this client should open the bridge socket on load
 */
export function shouldAutoConnect({ optedIn = false, headless = false } = {}) {
  return Boolean(optedIn) || Boolean(headless);
}
