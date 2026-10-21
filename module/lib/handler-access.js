/**
 * What each bridge handler may do to the world. Pure: no Foundry globals,
 * unit-tested from server/test.
 *
 * bridge.js dispatch() reads this for every call on both the direct and the
 * relay path: a handler missing here is refused outright, and "write" or
 * "delete" ones are refused while "Allow AI to modify the world" is off.
 * server/test/handler-access.test.js fails when a handler has no entry, so a
 * new handler cannot reach the world without someone deciding which it is.
 *
 * "write" covers anything that can change the world or what players see,
 * including chat, dialogs on other screens, UI clicks and arbitrary code
 * (evaluate, call_module_api): read-only mode means the AI changes nothing.
 */
export const HANDLER_ACCESS = Object.freeze({
  // reads
  get_debug_snapshot: "read", get_game_info: "read", list_actors: "read", get_actor: "read",
  get_selected_token: "read", list_modules: "read", list_compendiums: "read",
  search_compendium: "read", get_compendium_document: "read", list_items: "read",
  get_item: "read", get_active_effects: "read", get_scene: "read", get_console_errors: "read",
  get_data_model: "read", list_journals: "read", get_journal: "read", list_tables: "read",
  list_macros: "read", get_macro: "read", screenshot: "read", design_preview: "read",
  screenshot_dom: "read", capture_scene: "read", trace_hook: "read", trace_hooks: "read",
  trace_socket: "read", snapshot_actor: "read", diff_actor: "read", events_read: "read",
  events_wait: "read", get_available_conditions: "read", get_token_details: "read",
  snapshot_actors: "read", job_result: "read", get_actor_ownership: "read", get_combat: "read",
  get_chat_messages: "read", get_scene_placeables: "read", get_settings: "read",
  get_actor_items: "read", get_scene_levels: "read", list_region_behavior_types: "read",
  list_scenes: "read", query_grid: "read", changes_list: "read",

  // writes
  roll: "write", draw_table: "write", request_ask: "write", stage: "write", use_item: "write",
  move_token: "write", move_token_pathed: "write", update_token: "write",
  toggle_token_condition: "write", target: "write", click: "write",
  simulate_dialog_response: "write", evaluate: "write", create_folder: "write",
  create_actor_from_compendium: "write", create_actor: "write", add_items_to_actor: "write",
  create_journal_entry: "write", update_journal_page: "write", update_actor: "write",
  update_item_on_actor: "write", add_page_to_journal_entry: "write", create_token: "write",
  set_actor_ownership: "write", start_combat: "write", advance_combat: "write",
  send_chat_message: "write", request_roll: "write", request_roll_typed: "write",
  request_attack_roll: "write", request_damage_roll: "write", request_item_use: "write",
  apply_damage: "write", place_measured_template: "write", set_canvas_level: "write",
  add_scene_level: "write", update_scene_level: "write", create_region: "write",
  update_region: "write", update_scene: "write", activate_scene: "write",
  create_scene: "write", call_module_api: "write", changes_undo: "write",

  // deletes
  delete_tokens: "delete", delete_folder: "delete", delete_actor: "delete",
  delete_items_from_actor: "delete", delete_journal_entry: "delete",
  delete_journal_page: "delete", end_combat: "delete", remove_scene_level: "delete",
  delete_region: "delete", delete_scene: "delete", self_test: "delete",
});

export const MUTATION_SETTING = "allowWorldMutations";
const SETTING_LABEL = `"Allow AI to modify the world" (foundry-mcp-live.${MUTATION_SETTING})`;

/**
 * Why `tool` may not run, or null if it may.
 *
 * @param {string} tool
 * @param {() => unknown} readSetting  returns the world setting's value; may throw
 * @returns {string|null}
 */
export function accessRefusal(tool, readSetting) {
  const access = HANDLER_ACCESS[tool];
  if (!access) return `Unknown tool: ${tool}`;
  if (access === "read") return null;

  let value;
  try { value = readSetting(); }
  catch (err) {
    return `"${tool}" was refused: the world setting ${SETTING_LABEL} could not be read `
      + `(${err?.message ?? err}), and writes stay off until it can.`;
  }
  if (value === true) return null;
  if (value === false) {
    return `"${tool}" was refused: the world setting ${SETTING_LABEL} is off, so the AI bridge `
      + `is read-only. A GM can turn it back on in Configure Settings → Foundry MCP Live.`;
  }
  return `"${tool}" was refused: the world setting ${SETTING_LABEL} holds ${JSON.stringify(value)} `
    + `instead of true/false. A GM can fix it by toggling it in Configure Settings → Foundry MCP Live.`;
}
