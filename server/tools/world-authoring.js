/**
 * World-authoring tools — create actors, tokens, chat messages, rolls, combat
 * and scenes in the running Foundry world. These tools mutate persistent state
 * and are gated behind `FOUNDRY_MCP_ALLOW_WRITE=1` on the server. When the
 * gate is off, none of these tools are registered and they will not appear in
 * any MCP client's tool list — failing closed.
 *
 * All tools route through the standard `targetUser` mechanism, so the LLM
 * can scope authoring to a specific Foundry world when multiple bridges are
 * connected. The actual create/update calls run in the targeted user's
 * browser context with that user's permissions.
 */
import { z }                                     from "zod";
import { registerRoutedTool, registerRawTool, registerMergedTool, TARGET_USER_DESC, AUDIT_DESC } from "./_helpers.js";
import { callFoundry }                           from "../lib/foundry-rpc.js";
import { ALLOW_SELF_TEST, ALLOW_WRITE }          from "../lib/config.js";

export function registerWorldAuthoringTools(mcp) {
  if (!ALLOW_WRITE) return;

  if (ALLOW_SELF_TEST) {
    registerRoutedTool(mcp, "self_test",
      "Run a destructive schema-drift smoke test using uniquely flagged throwaway "
      + "Actor, JournalEntry, RollTable, and Scene documents. Always attempts "
      + "ID-based cleanup in finally and fails if anything remains.",
      {
        confirm: z.literal(true).describe(
          "Required acknowledgement that this tool temporarily creates and deletes world documents."
        ),
      });
  }

  // --- Actor write (merged: create_actor, create_actor_from_compendium, update_actor, delete_actor) ---
  registerMergedTool(mcp, "actor_write",
    "Create, import, update, or delete a world actor. "
    + "action 'create' needs name+type (system/items/img/prototypeToken/folderId/folderName optional) — "
    + "builds a new actor from scratch; call get_data_model first to learn the system block shape. "
    + "action 'fromCompendium' needs pack+documentId (folderId/folderName/nameOverride optional) — "
    + "imports an already-statted actor from a compendium pack. "
    + "action 'update' needs actorId plus at least one of name/img/system/prototypeToken — patches an actor. "
    + "action 'delete' needs actorId — permanent (Foundry's undo does not cover deletes).",
    {
      action: z.enum(["create", "fromCompendium", "update", "delete"]).describe("Actor operation to perform."),
      // shared id (update/delete)
      actorId:        z.string().optional().describe("[update/delete] Actor document id."),
      // create
      name:           z.string().optional().describe("[create] Actor name. [update] Replace the actor's name."),
      type:           z.string().optional().describe(
        "[create] Actor subtype, system-specific (e.g. 'character', 'npc' for dnd5e; "
        + "'Player' for shadowdark). Use `get_data_model({type: 'Actor'})` "
        + "to see valid types in the active system."
      ),
      system:         z.record(z.string(), z.any()).optional().describe(
        "[create] System-specific data block. Shape varies per game system. "
        + "Use `get_data_model({type: 'Actor', subtype: '<type>'})` to learn the structure. "
        + "[update] Merge into the actor's `system` data."
      ),
      items:          z.array(z.record(z.string(), z.any())).optional().describe(
        "[create] Optional inline items to attach at creation. Each entry is either "
        + "{ pack, documentId, nameOverride? } (from a compendium) or "
        + "{ name, type, system, ... } (inline definition)."
      ),
      img:            z.string().optional().describe("[create] Portrait image path/URL. [update] Replace the portrait image path/URL."),
      prototypeToken: z.record(z.string(), z.any()).optional().describe(
        "[create] Optional prototype token data (img, scale, disposition, etc.). "
        + "[update] Merge into the prototype token (affects future tokens placed from this actor)."
      ),
      folderId:       z.string().optional().describe("[create/fromCompendium] Target folder id (wins over folderName if both given)."),
      folderName:     z.string().optional().describe(
        "[create/fromCompendium] Target folder by exact name. Auto-created as an Actor folder if it doesn't exist."
      ),
      // fromCompendium
      pack:           z.string().optional().describe("[fromCompendium] Compendium pack id (e.g. 'dnd5e.monsters')."),
      documentId:     z.string().optional().describe("[fromCompendium] Document id within the pack."),
      nameOverride:   z.string().optional().describe("[fromCompendium] Rename the imported actor."),
      audit:          z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      create:         "create_actor",
      fromCompendium: "create_actor_from_compendium",
      update:         "update_actor",
      delete:         "delete_actor",
    },
    "action",
    {
      create:         ["name", "type"],
      fromCompendium: ["pack", "documentId"],
      update:         ["actorId"],
      delete:         ["actorId"],
    });

  // --- Combat (merged: start_combat, advance_combat, end_combat) ---
  registerMergedTool(mcp, "combat",
    "Control the combat tracker. "
    + "action 'start' (tokenIds/rollInitiative optional) — starts an encounter, creating one "
    + "on the current scene if none exists; can add tokens as combatants and roll initiative first. "
    + "action 'advance' (direction optional, default 'next') — advances the turn; Foundry handles "
    + "round transitions automatically. "
    + "action 'end' — ends/deletes the active combat (the scene token roster is unaffected).",
    {
      action: z.enum(["start", "advance", "end"]).describe("Combat operation to perform."),
      // start
      tokenIds:       z.array(z.string()).optional().describe("[start] Token ids to add as combatants before starting."),
      rollInitiative: z.union([z.boolean(), z.enum(["all", "npc"])]).optional().describe(
        "[start] If true or 'all', roll for every combatant. If 'npc', only roll for NPC combatants. Default: no auto-roll."
      ),
      // advance
      direction: z.enum(["next", "previous"]).optional().describe("[advance] Default 'next'."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    },
    { start: "start_combat", advance: "advance_combat", end: "end_combat" },
    "action",
    { start: [], advance: [], end: [] });

  // --- Request (merged: request_roll / request_check / request_item_use / request_ask) ---
  registerRawTool(mcp, "request",
    "Human-in-the-loop requests routed to a user's screen (not achievable via evaluate). "
    + "action 'roll' — pop a Roll dialog on the target user's screen; returns when they click "
    + "Roll/Cancel or after timeoutSeconds (autoAccept skips the dialog and rolls immediately). "
    + "action 'check' — system-native skill/ability/save check on an actor; dialogs suppressed. "
    + "action 'itemUse' — item combat workflow; phase 'full' = attack→damage→apply (crit state "
    + "threaded through), 'attack' = attack roll only, 'damage' = damage roll only (caller "
    + "supplies crit). Dialogs suppressed. "
    + "action 'ask' — ask the target user a question in a dialog: `choices` become buttons, `freeText` "
    + "adds a text box. Returns status answered (with choice/index/text), dismissed or timeout. Use 'ask' "
    + "rather than a chat message when you need one structured answer from one player; target a user "
    + "that list_connected_bridges shows connected, or the dialog never appears. MCP clients give up near "
    + "60 s, so keep timeoutSeconds under ~40; a later answer is still recorded — read it with "
    + "chat action 'events' (kind 'ask') routed to the same user.",
    {
      action: z.enum(["roll", "check", "itemUse", "ask"]).describe("Which request to run."),
      // ask
      question:       z.string().optional().describe("[ask] The question shown to the user (plain text)."),
      title:          z.string().optional().describe("[ask] Dialog title. Default 'A question from the GM'."),
      choices:        z.array(z.string()).max(8).optional().describe("[ask] Button labels, first is default. Default ['Yes','No'] (or ['Answer'] with freeText)."),
      freeText:       z.boolean().optional().describe("[ask] Show a text box; its value is returned as text."),
      // roll
      formula:        z.string().optional().describe("[roll] Dice formula (e.g. '1d20+5', '2d6', '@abilities.str.mod + 1d20')."),
      prompt:         z.string().optional().describe("[roll] Text shown in the dialog. Default: 'The GM is requesting a roll.'"),
      label:          z.string().optional().describe("[roll] Short label for the dialog title + chat flavor."),
      timeoutSeconds: z.number().int().min(5).max(300).optional().describe("[roll/ask] Dialog wait time. Default 60s (roll) / 30s (ask), max 300s."),
      autoAccept:     z.boolean().optional().describe("[roll] Skip the dialog and roll immediately. Default false."),
      // check
      actorId:    z.string().optional().describe("[check/itemUse] Actor ID or name."),
      checkType:  z.enum(["skill", "ability", "save"]).optional().describe("[check] Category of the roll."),
      identifier: z.string().optional().describe("[check] System-specific ID (e.g. 'ath' for 5e Athletics, 'athletics' for PF2e, 'str' for Shadowdark stat)."),
      dc:         z.number().optional().describe("[check] Target DC for success evaluation."),
      adv:        z.enum(["normal", "advantage", "disadvantage"]).optional().describe("[check/itemUse] Force advantage state (system-dependent; ignored where unsupported)."),
      // itemUse
      phase:      z.enum(["full", "attack", "damage"]).optional().describe("[itemUse] Which workflow part to run. Default 'full'."),
      itemId:     z.string().optional().describe("[itemUse] Item/weapon ID or name."),
      targetIds:  z.array(z.string()).optional().describe("[itemUse/full] If provided, damage is applied to these targets on hit."),
      activityId: z.string().optional().describe("[itemUse] D&D 5e activity ID (when an item has multiple attack activities)."),
      isCritical: z.boolean().optional().describe("[itemUse/damage] Force critical damage (doubles dice on d20 systems)."),
      audit:      z.boolean().optional().describe(AUDIT_DESC),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async (params) => {
      const { action, targetUser, ...rest } = params;
      if (action === "roll") {
        const { timeoutSeconds = 60, ...rollRest } = rest;
        // Server-side RPC needs a slightly longer timeout than the dialog so
        // the dialog timeout fires inside the bridge, not at the server layer.
        const bridgeTimeoutMs = Math.max(15_000, (timeoutSeconds + 5) * 1000);
        return callFoundry("request_roll", { ...rollRest, timeoutSeconds }, targetUser, bridgeTimeoutMs);
      }
      if (action === "ask") {
        if (!rest.question) return { content: [{ type: "text", text: "Error: request action 'ask' requires question." }] };
        const { question, title, choices, freeText, timeoutSeconds = 30 } = rest;
        return callFoundry("request_ask", { question, title, choices, freeText, timeoutSeconds },
          targetUser, (timeoutSeconds + 5) * 1000);
      }
      if (action === "check") {
        if (!rest.actorId && !rest.identifier) {
          return { content: [{ type: "text", text:
            "Error: request action 'check' requires actorId + checkType + identifier." }] };
        }
        // bridge-side handler request_roll_typed expects the discriminator as `type`
        const { checkType, ...checkRest } = rest;
        return callFoundry("request_roll_typed",
          { ...checkRest, type: checkType }, targetUser);
      }
      if (action === "itemUse") {
        const phase = rest.phase ?? "full";
        const bridgeTool = { full: "request_item_use", attack: "request_attack_roll", damage: "request_damage_roll" }[phase];
        if (!bridgeTool) {
          return { content: [{ type: "text", text:
            `Error: unknown phase "${phase}" for request itemUse (use full|attack|damage).` }] };
        }
        const req = { ...rest };
        delete req.phase;
        let timeoutMs;
        if (phase === "full") {
          // many-target AoE damage application is slow — scale the RPC timeout
          req.targetIds = Array.isArray(req.targetIds) ? req.targetIds : [];
          timeoutMs = Math.max(15_000, 10_000 + (req.targetIds.length * 5000));
        }
        return callFoundry(bridgeTool, req, targetUser, timeoutMs);
      }
      return { content: [{ type: "text", text:
        `Error: unknown action "${action}" for request. Valid: roll, check, itemUse, ask.` }] };
    });

  // --- Apply damage (v0.10.0) ---
  registerRoutedTool(mcp, "apply_damage",
    "Applies damage to one or more targets with mixed outcomes (AoE support).",
    {
      damages: z.array(z.object({
        targetId:   z.string().describe("Target actor/token ID."),
        amount:     z.number().describe("Total damage value."),
        type:       z.string().optional().describe("Damage type (e.g. 'fire')."),
        multiplier: z.number().optional().describe("Multiplier (e.g. 0.5 for half)."),
      })).describe("Per-target damage descriptors."),
      audit:  z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Scene (merged: create_scene, update_scene, activate_scene, delete_scene) ---
  registerMergedTool(mcp, "scene",
    "Create, update, activate, or delete a scene. "
    + "action 'create' needs name (width/height/padding/grid*/backgroundColor/background/foreground/"
    + "levelFog/fog/fogExploration/folderId/activate optional) — activates the new scene unless activate:false. "
    + "action 'update' needs sceneId plus the whitelisted fields to patch (name, padding, backgroundColor, "
    + "background, foreground, levelFog, fog, grid, navigation, sort, navName, fogExploration, initial). "
    + "action 'activate' needs sceneId or sceneName — switches the canvas to view it. "
    + "action 'delete' needs sceneId or sceneName (force optional — required to delete the active scene). Permanent.",
    {
      action: z.enum(["create", "update", "activate", "delete"]).describe("Scene operation to perform."),
      // shared id / name
      sceneId:   z.string().optional().describe("[update] Target scene id. [activate/delete] Scene document id (preferred — unambiguous)."),
      sceneName: z.string().optional().describe("[activate/delete] Scene name (exact match). Used only if `sceneId` is omitted."),
      name:      z.string().optional().describe("[create] Scene name (shown in the sidebar). [update] New scene name."),
      // create-specific geometry
      width:           z.number().int().optional().describe("[create] Width in pixels. Default 4000."),
      height:          z.number().int().optional().describe("[create] Height in pixels. Default 3000."),
      gridType:        z.number().int().optional().describe("[create] CONST.GRID_TYPES value (0=Gridless, 1=Square, 2-5=Hex variants). Default 1 (Square)."),
      gridSize:        z.number().int().optional().describe("[create] Grid cell size in pixels. Default 100."),
      gridAlpha:       z.number().optional().describe("[create] Grid line alpha (0.0–1.0). Default 0.2."),
      folderId:        z.string().optional().describe("[create] Parent folder id (Scene type)."),
      activate:        z.boolean().optional().describe("[create] Activate after creating. Default true."),
      // shared create/update fields
      padding:         z.number().optional().describe("[create] Outer padding (0.0–0.5). Default 0.25. [update] New padding."),
      backgroundColor: z.string().optional().describe("[create] Hex background color. Default '#1c1c1c'. [update] New hex background color."),
      background:      z.union([z.string(), z.record(z.string(), z.any())]).optional().describe(
        "[create] Background image path or data object. [update] Background data object (e.g. {src: 'path/to/image.webp'}). "
        + "On v14 background fields map to Level.background and transforms to Level.textures."
      ),
      foreground:      z.record(z.string(), z.any()).optional().describe("[create/update] Foreground texture data; Level-backed on v14."),
      levelFog:        z.record(z.string(), z.any()).optional().describe("[create/update] Level fog texture data {src, tint}; v14 only."),
      fog:             z.record(z.string(), z.any()).optional().describe("[create/update] Scene fog config, e.g. {mode: 0|1|2, colors}."),
      fogExploration:  z.boolean().optional().describe("[create/update] Compatibility boolean for fog exploration. On v14 update maps false→fog.mode 0 and true→fog.mode 1."),
      // update-only fields
      grid:            z.record(z.string(), z.any()).optional().describe("[update] Grid object (e.g. {size: 100, type: 1, alpha: 0.2})."),
      navigation:      z.boolean().optional().describe("[update] Whether the scene appears in the navigation bar."),
      sort:            z.number().int().optional().describe("[update] Navigation sort order."),
      navName:         z.string().optional().describe("[update] Short name shown in the navigation bar."),
      initial:         z.record(z.string(), z.any()).optional().describe("[update] Initial view config (e.g. {level: '<levelId>', x, y, scale})."),
      // delete-only
      force:     z.boolean().optional().describe("[delete] Set true to delete even if the scene is currently active. Default false."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      create:   "create_scene",
      update:   "update_scene",
      activate: "activate_scene",
      delete:   "delete_scene",
    },
    "action",
    {
      create:   ["name"],
      update:   ["sceneId"],
      activate: [],
      delete:   [],
    });

  // --- Placeable (scene authoring; bridge handler `placeable`, placeables.js) ---
  registerRoutedTool(mcp, "placeable",
    "Author scene placeables: walls, lights, sounds, tiles, drawings, regions, map notes. One type per call, "
    + "up to 200 entries. Works without a drawn canvas (document APIs). "
    + "action 'create' needs type + entries (each entry is that document's data, e.g. Wall {c:[x1,y1,x2,y2]} in "
    + "pixels; Region {name, shapes:[{type:'rectangle',x,y,width,height}], behaviors}). "
    + "action 'update' needs type + entries, each with _id plus the fields to change (dotted keys allowed). "
    + "Every entry is validated by Foundry's data model first; one bad entry means nothing is written and the "
    + "error lists each bad entry. The result's storedDifferently lists fields Foundry stored differently from "
    + "what was sent (rounded coordinates, clamped values). "
    + "On a scene with several Levels (v14) pass level (id or name) or each entry's levels; an entry with "
    + "neither is refused, because an empty levels list puts the placeable on every Level. "
    + "Wall fields take plain words as well as CONST numbers: door none|door|secret, ds closed|open|locked, "
    + "move none|normal, sight/light/sound none|limited|normal|proximity|distance, dir both|left|right. "
    + "action 'delete' needs type + ids, or createdByMcp:true for every document of that type this tool created "
    + "(it flags them flags.foundry-mcp-live.createdBy), or callId (returned by create) for exactly what one "
    + "create call made (never both ids and a selector); call it with dryRun:true first to see what would go. "
    + "Permanent. "
    + "action 'door' needs ids (door walls) + state open|closed|locked. "
    + "Call scene_read action 'placeables' first to find ids, and query_grid mode 'collision' after building "
    + "walls to check they block what you meant. sceneId defaults to the active scene.",
    {
      action:       z.enum(["create", "update", "delete", "door"]).describe("Operation."),
      type:         z.enum(["Wall", "AmbientLight", "AmbientSound", "Tile", "Drawing", "Region", "Note"]).optional()
                     .describe("[create/update/delete] Placeable document type. 'door' is always Wall."),
      sceneId:      z.string().optional().describe("Target scene id. Default: active scene."),
      entries:      z.array(z.record(z.string(), z.any())).max(200).optional()
                     .describe("[create] Document data, one per placeable. [update] {_id, ...fields to change}."),
      ids:          z.array(z.string()).max(200).optional().describe("[delete/door] Document ids."),
      level:        z.string().optional().describe("[create] Level id or name for entries without their own levels (v14 multi-level scenes)."),
      createdByMcp: z.boolean().optional().describe("[delete] Select every document of `type` this tool created instead of ids."),
      callId:       z.string().optional().describe("[delete] Select only the documents one create call made (its result's callId)."),
      dryRun:       z.boolean().optional().describe("[delete] List what would be deleted; delete nothing."),
      state:        z.enum(["open", "closed", "locked"]).optional().describe("[door] New door state."),
      audit:        z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Stage (live-play staging; bridge handler `stage`, live-play.js) ---
  registerRawTool(mcp, "stage",
    "Put things in front of the players during play. "
    + "action 'showJournal' needs journal (page optional) — opens the entry/page on players' screens "
    + "(force default true: shown even to players without permission). "
    + "action 'shareImage' needs image (path or URL; title/caption optional) — pops it up for players. "
    + "action 'pause' (paused optional: true/false, omit to toggle) — pauses or resumes the game for everyone. "
    + "action 'pullToScene' needs scene — moves connected players' view to that scene without making it "
    + "the active scene; use scene action 'activate' rather than this when everyone should move and the "
    + "scene should become active. "
    + "action 'playlist' needs playlist (sound optional, play default true) — play or stop a playlist or one track. "
    + "`users` (names or ids) limits showJournal/shareImage/pullToScene to some players; omit for everyone. "
    + "Call list/scene_read first to find names; use this rather than evaluate for any of these.",
    {
      action:   z.enum(["showJournal", "shareImage", "pause", "pullToScene", "playlist"]).describe("Staging operation."),
      journal:  z.string().optional().describe("[showJournal] JournalEntry id or name."),
      page:     z.string().optional().describe("[showJournal] Page id or name within the entry; omit to show the whole entry."),
      force:    z.boolean().optional().describe("[showJournal] Show even to users without view permission. Default true."),
      image:    z.string().optional().describe("[shareImage] Image path (relative to Foundry data) or URL."),
      title:    z.string().optional().describe("[shareImage] Popout window title."),
      caption:  z.string().optional().describe("[shareImage] Caption under the image."),
      paused:   z.boolean().optional().describe("[pause] true pauses, false resumes; omit to toggle."),
      scene:    z.string().optional().describe("[pullToScene] Scene id or name."),
      playlist: z.string().optional().describe("[playlist] Playlist id or name."),
      sound:    z.string().optional().describe("[playlist] One sound (track) id or name; omit for the whole playlist."),
      play:     z.boolean().optional().describe("[playlist] true plays, false stops. Default true."),
      users:    z.array(z.string()).optional().describe("[showJournal/shareImage/pullToScene] User names or ids; omit for everyone."),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async ({ targetUser, ...params }) => {
      const required = { showJournal: "journal", shareImage: "image", pullToScene: "scene", playlist: "playlist" }[params.action];
      if (required && !params[required]) {
        return { content: [{ type: "text", text: `Error: stage action '${params.action}' requires ${required}.` }] };
      }
      return callFoundry("stage", params, targetUser);
    });
}
