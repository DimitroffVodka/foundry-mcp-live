/**
 * World-state tools — game info, merged list/document/chat surfaces,
 * compendium search, data model, combat read, settings, debug snapshot,
 * module API bridge.
 *
 * Merged surfaces (2026-08-19 reduction):
 *   - `list`     — list_actors / list_scenes / list_modules / list_tables / list_compendiums / list_journals
 *   - `document` — get_actor / get_item / get_compendium_document / get_actor_items / get_journal
 *   - `chat`     — send_chat_message / get_chat_messages / events_read / events_wait (send is write-gated at call time)
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
    + "compendium (packs with metadata; optional document-type `filter`), "
    + "journal (entries with their pages; `query` searches entry names and page text and returns snippets; "
    + "paginated {total, offset, count, items, truncated} — read a page with document action 'journal').",
    {
      type:       z.enum(["actor", "scene", "module", "rollTable", "compendium", "journal"]).describe("Collection to list."),
      filter:     z.string().optional().describe("[actor] Actor subtype (e.g. 'character', 'npc'). [compendium] Document type (e.g. 'Actor', 'Item')."),
      folder:     z.string().optional().describe("[actor/journal] Filter by folder name."),
      activeOnly: z.boolean().optional().describe("[module] Include inactive modules if false. Default true."),
      query:      z.string().optional().describe("[journal] Case-insensitive text to find in entry names, page names and page text."),
      secrets:    z.boolean().optional().describe("[journal] Also search GM secret blocks. Default false."),
      offset:     z.number().int().min(0).optional().describe("[journal] Skip this many entries. Default 0."),
      limit:      z.number().int().min(1).max(500).optional().describe("[journal] Max entries per call. Default 50."),
    },
    { actor: "list_actors", scene: "list_scenes", module: "list_modules",
      rollTable: "list_tables", compendium: "list_compendiums", journal: "list_journals" },
    "type",
    {});

  // --- Document (merged) ---
  registerMergedTool(mcp, "document",
    "Read one document. `action` picks the kind: "
    + "actor — full actor data by `id` or exact `name`; "
    + "item — full world item by `id` or `name`; "
    + "compendium — one document from a pack (`pack` + `id`/`name`); "
    + "actorItems — focused {id,name,type,img,system} list of an actor's embedded items "
    + "(`actorId`; optional item-type `filter`) — much smaller than a full actor read; "
    + "journal — a journal entry's pages as Markdown (`id`/`name`, optional `pack`, `page`), paginated "
    + "{total, offset, count, items, truncated}; `enrich` resolves @UUID links and inline rolls first. "
    + "`derived: true` on actor/item/compendium returns the PREPARED values the sheet shows "
    + "(toObject(false).system, appliedEffects, getRollData()) instead of the stored source.",
    {
      action:     z.enum(["actor", "item", "compendium", "actorItems", "journal"]).describe("Document kind."),
      id:         z.string().optional().describe("[actor/item/compendium/journal] Document ID."),
      name:       z.string().optional().describe("[actor/item/compendium/journal] Exact name (case-insensitive in a compendium)."),
      pack:       z.string().optional().describe("[compendium/journal] Pack ID (e.g. 'vagabond.monsters'). [journal] read the entry from this pack instead of the world."),
      actorId:    z.string().optional().describe("[actorItems] Actor document id or exact name."),
      filter:     z.string().optional().describe("[actorItems] Item type filter (e.g. 'weapon', 'spell')."),
      derived:    z.boolean().optional().describe("[actor/item/compendium] Return prepared data: {system: toObject(false).system, appliedEffects, rollData: getRollData()}. rollData carries non-schema derived values (e.g. dnd5e abilities.*.mod). Default false (stored source)."),
      page:       z.string().optional().describe("[journal] Read only this page (id or exact name)."),
      offset:     z.number().int().min(0).optional().describe("[journal] Skip this many pages. Default 0."),
      limit:      z.number().int().min(1).max(100).optional().describe("[journal] Max pages per call. Default 20."),
      maxChars:   z.number().int().min(500).max(200000).optional().describe("[journal] Character budget for the reply's Markdown. Default 20000. Overflow is reported in the truncated/note fields."),
      textOffset: z.number().int().min(0).optional().describe("[journal] With `page`: start at this character of the page's Markdown (to continue a cut page)."),
      enrich:     z.boolean().optional().describe("[journal] Run page HTML through TextEditor.enrichHTML first (resolves @UUID links, inline rolls, system enrichers). Default false."),
      secrets:    z.boolean().optional().describe("[journal] Include GM secret blocks. Default false."),
    },
    { actor: "get_actor", item: "get_item", compendium: "get_compendium_document", actorItems: "get_actor_items",
      journal: "get_journal" },
    "action",
    { compendium: ["pack"], actorItems: ["actorId"] });

  // --- Chat (merged; send is write-gated) ---
  registerRawTool(mcp, "chat",
    "Chat log access. action 'send' — post a chat message as the routed user (default GM); "
    + "optionally speak as actorId/tokenId or whisper via whisperTo. Write-gated: requires "
    + "FOUNDRY_MCP_ALLOW_WRITE=1 on the server. "
    + "action 'read' — read chat history with filters limit/since/speaker/includeRolls/includeWhispers. "
    + "action 'events' — the live event cursor: every chat message, roll and `request` ask answer since "
    + "`sinceSeq`, each with a monotonic seq number (whispers included, flagged). Use 'events' rather than 'read' "
    + "to follow play turn by turn: keep the returned `latestSeq` and pass it as `sinceSeq` next time. "
    + "The buffer holds the last 300 events of the routed client and restarts on reload (`reset: true`). "
    + "action 'wait' — block until the next event matching kind/user/speaker/contains arrives (or one "
    + "already after `sinceSeq`); `timeoutSeconds` max 40. MCP clients give up near 60 s, so wait in short "
    + "rounds: a reply that lands after a timeout is still in the buffer — read it with 'events'. "
    + "Call 'events' (or 'wait' with sinceSeq) after posting a question, so a fast reply is not missed.",
    {
      action:          z.enum(["send", "read", "events", "wait"]).describe("Chat operation."),
      content:         z.string().optional().describe("[send] HTML content of the message."),
      speaker:         z.string().optional().describe("[send] Display alias for the speaker. [read/events/wait] Filter by speaker alias (actor name) or actor id."),
      actorId:         z.string().optional().describe("[send] Speak as this actor."),
      tokenId:         z.string().optional().describe("[send] Speak as this token (on the active scene)."),
      whisperTo:       z.union([z.string(), z.array(z.string())]).optional().describe("[send] User name(s) to whisper to. Other users won't see the message."),
      type:            z.union([z.enum(["OOC", "IC", "EMOTE", "WHISPER", "ROLL", "OTHER"]), z.number().int()]).optional().describe("[send] Message type. Default 'OOC'."),
      limit:           z.number().int().min(1).max(500).optional().describe("[read/events] Max messages/events to return (newest kept). Default 50; events cap 300."),
      sinceSeq:        z.number().int().min(0).optional().describe("[events/wait] Cursor: only events with seq greater than this. [wait] Omit to wait for the next new event only."),
      kind:            z.enum(["chat", "roll", "ask"]).optional().describe("[events/wait] Event kind: chat (no rolls), roll (message carries rolls), ask (a `request` ask answer/timeout)."),
      user:            z.string().optional().describe("[events/wait] Author user name or id."),
      contains:        z.string().optional().describe("[events/wait] Case-insensitive substring of the message text or flavor."),
      timeoutSeconds:  z.number().int().min(1).max(40).optional().describe("[wait] How long to block. Default 30, max 40."),
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
      if (action === "events") return callFoundry("events_read", rest, targetUser);
      if (action === "wait") {
        const { timeoutSeconds = 30 } = rest;
        return callFoundry("events_wait", rest, targetUser, (timeoutSeconds + 5) * 1000);
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