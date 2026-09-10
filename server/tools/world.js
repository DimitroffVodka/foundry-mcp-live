/**
 * World-state tools — game info, merged list/document/chat surfaces,
 * compendium search, data model, combat read, settings, debug snapshot,
 * module API bridge.
 *
 * Merged surfaces (2026-08-19 reduction):
 *   - `list`     — list_actors / list_scenes / list_modules / list_tables / list_compendiums
 *   - `document` — get_actor / get_item / get_compendium_document / get_actor_items
 *   - `chat`     — send_chat_message / get_chat_messages (send is write-gated at call time)
 */
import { z }                                                       from "zod";
import { registerRoutedTool, registerRawTool, registerMergedTool,
         TARGET_USER_DESC, AUDIT_DESC }                            from "./_helpers.js";
import { ALLOW_WRITE }                                             from "../lib/config.js";
import { codedMessage }                                            from "../lib/errors.js";
import { callFoundry }                                             from "../lib/foundry-rpc.js";

export function registerWorldTools(mcp) {
  // --- Game info ---
  registerRoutedTool(mcp, "get_game_info",
    "Get basic info about the running Foundry VTT instance: game system, world, version, connected users.",
    {});

  // --- List (merged) ---
  registerMergedTool(mcp, "list",
    "List world collections. `type` picks the collection: "
    + "actor (optionally filter by actor subtype via `filter` or folder name via `folder`), "
    + "scene (every scene as {id,name,active,folder}), "
    + "module (installed modules; `activeOnly` default true), "
    + "rollTable (tables with formulas and result counts), "
    + "compendium (packs with metadata; optional document-type `filter`).",
    {
      type:       z.enum(["actor", "scene", "module", "rollTable", "compendium"]).describe("Collection to list."),
      filter:     z.string().optional().describe("[actor] Actor subtype (e.g. 'character', 'npc'). [compendium] Document type (e.g. 'Actor', 'Item')."),
      folder:     z.string().optional().describe("[actor] Filter by folder name."),
      activeOnly: z.boolean().optional().describe("[module] Include inactive modules if false. Default true."),
    },
    { actor: "list_actors", scene: "list_scenes", module: "list_modules",
      rollTable: "list_tables", compendium: "list_compendiums" },
    "type",
    {});

  // --- Document (merged) ---
  registerMergedTool(mcp, "document",
    "Read one document. `action` picks the kind: "
    + "actor — full actor data by `id` or exact `name`; "
    + "item — full world item by `id` or `name`; "
    + "compendium — one document from a pack (`pack` + `id`/`name`); "
    + "actorItems — focused {id,name,type,img,system} list of an actor's embedded items "
    + "(`actorId`; optional item-type `filter`) — much smaller than a full actor read.",
    {
      action:  z.enum(["actor", "item", "compendium", "actorItems"]).describe("Document kind."),
      id:      z.string().optional().describe("[actor/item/compendium] Document ID."),
      name:    z.string().optional().describe("[actor/item/compendium] Exact name (case-insensitive for compendium)."),
      pack:    z.string().optional().describe("[compendium] Pack ID (e.g. 'vagabond.monsters')."),
      actorId: z.string().optional().describe("[actorItems] Actor document id or exact name."),
      filter:  z.string().optional().describe("[actorItems] Item type filter (e.g. 'weapon', 'spell')."),
    },
    { actor: "get_actor", item: "get_item", compendium: "get_compendium_document", actorItems: "get_actor_items" },
    "action",
    { compendium: ["pack"], actorItems: ["actorId"] });

  // --- Chat (merged; send is write-gated) ---
  registerRawTool(mcp, "chat",
    "Chat log access. action 'send' — post a chat message as the routed user (default GM); "
    + "optionally speak as actorId/tokenId or whisper via whisperTo. Write-gated: requires "
    + "FOUNDRY_MCP_ALLOW_WRITE=1 on the server. "
    + "action 'read' — read chat history with filters limit/since/speaker/includeRolls/includeWhispers.",
    {
      action:          z.enum(["send", "read"]).describe("Chat operation."),
      content:         z.string().optional().describe("[send] HTML content of the message."),
      speaker:         z.string().optional().describe("[send] Display alias for the speaker. [read] Filter by speaker.alias (actor name) or speaker.actor (actor id)."),
      actorId:         z.string().optional().describe("[send] Speak as this actor."),
      tokenId:         z.string().optional().describe("[send] Speak as this token (on the active scene)."),
      whisperTo:       z.union([z.string(), z.array(z.string())]).optional().describe("[send] User name(s) to whisper to. Other users won't see the message."),
      type:            z.union([z.enum(["OOC", "IC", "EMOTE", "WHISPER", "ROLL", "OTHER"]), z.number().int()]).optional().describe("[send] Message type. Default 'OOC'."),
      limit:           z.number().int().min(1).max(500).optional().describe("[read] Max messages to return. Default 50."),
      since:           z.union([z.string(), z.number()]).optional().describe("[read] Only messages from this point on (ISO timestamp or epoch ms)."),
      includeRolls:    z.boolean().optional().describe("[read] Include roll messages. Default true."),
      includeWhispers: z.boolean().optional().describe("[read] Include whispers. Default false."),
      audit:           z.boolean().optional().describe(AUDIT_DESC),
      targetUser:      z.string().optional().describe(TARGET_USER_DESC),
    },
    async (params) => {
      const { action, targetUser, ...rest } = params;
      if (action === "send" && !ALLOW_WRITE) {
        return { content: [{ type: "text", text: codedMessage("FML-0003",
          "chat action 'send' requires the server env gate FOUNDRY_MCP_ALLOW_WRITE=1.") }] };
      }
      const bridgeTool = action === "send" ? "send_chat_message" : "get_chat_messages";
      return callFoundry(bridgeTool, rest, targetUser);
    });

  // --- Compendium search ---
  registerRoutedTool(mcp, "search_compendium",
    "Search a compendium pack by text query.",
    {
      pack:  z.string().describe("Pack ID (e.g. 'vagabond.monsters')"),
      query: z.string().optional().describe("Text to search for in entry names"),
      full:  z.boolean().optional().describe("Return full documents if true (max 20)"),
    });

  // --- Data model ---
  registerRoutedTool(mcp, "get_data_model",
    "Get the system data model template for a document type.",
    {
      type:    z.string().optional().describe("'Actor' or 'Item'. Default: 'Actor'"),
      subtype: z.string().optional().describe("Sub-type (e.g. 'character', 'monster')"),
    });

  // --- Combat tracker (read) ---
  registerRoutedTool(mcp, "get_combat",
    "Get the state of the active combat encounter — round, current turn, "
    + "and an initiative-sorted combatant list with HP/defeated/hidden flags. "
    + "Returns `{ active: false }` when no combat is running.",
    {});

  // --- Settings (v0.11) ---
  registerRoutedTool(mcp, "get_settings",
    "Read Foundry settings. Three modes: "
    + "(1) No args → catalog of every registered (namespace, key) pair "
    + "without values. "
    + "(2) `moduleId` only → all settings for that namespace with current values. "
    + "(3) `moduleId` + `key` → just that one setting's value.",
    {
      moduleId: z.string().optional().describe("Module/system namespace (e.g. 'core', 'dnd5e', 'levels')."),
      key:      z.string().optional().describe("Specific setting key within the namespace."),
    });

  // --- Debug snapshot (v0.12.3) ---
  registerRoutedTool(mcp, "get_debug_snapshot",
    "One-call situational awareness aggregator. Returns game/world/system "
    + "info, active scene, selected token, current targets, combat state, "
    + "recent console errors, recent chat, and the active module list. "
    + "Use this as the default 'what's going on?' tool — replaces 8+ "
    + "individual reads with one round trip during debugging.",
    {});

  // --- Module API call (v0.11.1) ---
  registerRoutedTool(mcp, "call_module_api",
    "Call a function exposed on `game.modules.get(moduleId).api`. Allowlist-"
    + "style alternative to `evaluate` — only functions a module deliberately "
    + "puts on its `.api` surface are reachable. The module author chooses "
    + "what's callable, so this avoids the arbitrary-code-execution surface "
    + "of evaluate while still letting agents drive third-party integrations "
    + "(shadowdark-extras dungeon generation, mythic-gme-tools fate questions, "
    + "etc.). Args are passed positionally; result is JSON-serialised.",
    {
      moduleId: z.string().describe("Module ID (e.g. 'shadowdark-extras', 'mythic-gme-tools')."),
      fn:       z.string().optional().describe(
        "Function name on `module.api`. **Omit to discover what's available** — "
        + "returns the full list without calling anything."
      ),
      args:     z.array(z.any()).optional().describe("Positional args. Default: []. "),
    });
}