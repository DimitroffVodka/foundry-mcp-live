/**
 * Relay-path guards. Pure: no Foundry globals, unit-tested from server/test.
 *
 * A relayed packet reaches the bridge's handlers without passing the MCP
 * server's gates, so dispatchRelayTool re-asserts them here.
 */

/**
 * Bridge handlers a server tool actually routes to. Anything else in the
 * handlers table (leftovers from the tool consolidations) is refused over the
 * relay. server/test/relay-guard.test.js keeps this list and the server tools
 * in step in both directions.
 */
export const RELAY_TOOLS = new Set([
  "get_debug_snapshot", "get_game_info", "list_actors", "get_actor", "list_modules",
  "list_compendiums", "search_compendium", "get_compendium_document", "get_item",
  "get_scene", "get_console_errors", "get_data_model", "list_tables", "screenshot",
  "design_preview", "screenshot_dom", "capture_scene", "trace_hooks", "trace_socket",
  "roll", "use_item", "get_token_details", "move_token", "update_token", "delete_tokens",
  "toggle_token_condition", "target", "click", "simulate_dialog_response",
  "snapshot_actors", "evaluate", "job_result", "self_test", "create_actor_from_compendium",
  "create_actor", "delete_actor", "update_actor", "create_token", "get_combat",
  "start_combat", "end_combat", "advance_combat", "get_chat_messages", "send_chat_message",
  "request_roll", "request_roll_typed", "request_attack_roll", "request_damage_roll",
  "request_item_use", "apply_damage", "get_scene_placeables", "get_settings",
  "get_actor_items", "set_canvas_level", "update_scene", "activate_scene", "list_scenes",
  "create_scene", "delete_scene", "call_module_api", "query_grid",
  "list_journals", "get_journal", "draw_table", "stage", "events_read", "events_wait",
  "request_ask",
]);

const MAX_DEPTH = 64;
const nonEmpty = v => typeof v === "string" && v.trim() !== "";

/**
 * Find code that a write would store for something to run later: Region
 * behaviors executeScript/executeMacro, script Macros, Monk's Active Tiles
 * actions (runcode/runmacro, and MAT evals its value fields), Mass Edit spawn
 * scripts, Item Piles macros, Item Macro / DAE / Effect Macro scripts.
 * Walks nested objects and Foundry's flattened "a.b.c" keys alike.
 *
 * @param {unknown} params  a relayed tool's params
 * @returns {string[]} one reason per finding; empty means nothing found
 */
export function findStoredCode(params) {
  const found = [];
  walk(params, [], false, 0, found);
  return found;
}

function walk(v, path, inBehavior, depth, found) {
  const at = path.join(".") || "(root)";
  if (depth > MAX_DEPTH) { found.push(`${at}: nested too deep to inspect`); return; }

  // MAT evaluates action data fields as JavaScript, so any write to a tile's
  // action list (whole or partial) is code.
  if (path.includes("monks-active-tiles") && path.includes("actions")) {
    found.push(`${at}: Monk's Active Tiles actions`);
    return;
  }

  if (typeof v === "string") {
    if (!nonEmpty(v)) return;
    const last = path.at(-1) ?? "";
    const parents = path.slice(0, -1);
    if (last.endsWith("SpawnScript")) found.push(`${at}: Mass Edit spawn script`);
    else if (last === "macro" && path.includes("item-piles")) found.push(`${at}: Item Piles macro`);
    else if ((last === "command" || last === "script") && parents.some(p => /macro/i.test(p))) {
      found.push(`${at}: macro script`);
    } else if (inBehavior && path.at(-2) === "system" && (last === "source" || last === "uuid")) {
      // An update to an existing behavior carries no `type`, so the field
      // name is all there is to go on.
      found.push(`${at}: Region behavior script/macro`);
    }
    return;
  }
  if (!v || typeof v !== "object") return;

  if (!Array.isArray(v)) {
    if (typeof v.type === "string" && /^execute(Script|Macro)$/.test(v.type)) {
      found.push(`${at}: Region behavior "${v.type}"`);
    }
    if (v.type === "script" && nonEmpty(v.command)) found.push(`${at}: script Macro`);
    if (v.documentName === "RegionBehavior") inBehavior = true;
  }

  for (const [k, child] of Object.entries(v)) {
    const segs = Array.isArray(v) ? path : [...path, ...k.split(".")];
    const behavior = inBehavior || segs.some(s => /^behaviors?$/i.test(s));
    walk(child, segs, behavior, depth + 1, found);
  }
}
