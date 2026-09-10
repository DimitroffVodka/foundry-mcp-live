/**
 * Canvas + token tools.
 *
 * Merged surfaces (2026-08-19 reduction):
 *   - `scene_read` — get_scene / get_scene_placeables
 *   - `token`      — move_token / create_token / update_token / delete_tokens /
 *                    toggle_token_condition / target / set_canvas_level
 *
 * `screenshot` stays separate (image-returning, Type-B: callFoundryImage);
 * `query_grid` stays separate (complex spatial schema).
 */
import { z }                                from "zod";
import { registerRoutedTool, registerRawTool, registerMergedTool, TARGET_USER_DESC, AUDIT_DESC } from "./_helpers.js";
import { callFoundry, callFoundryImage }    from "../lib/foundry-rpc.js";
import { cdpScreenshot }                    from "../lib/cdp-screenshot.js";

export function registerCanvasTools(mcp) {
  // --- Scene reads (merged) ---
  registerMergedTool(mcp, "scene_read",
    "Read the active scene. action 'summary' — get_scene: dimensions, grid settings, fog-of-war "
    + "mode, and all tokens with positions and per-token fog exploration state (inExplored). "
    + "action 'placeables' — get_scene_placeables: list a given placeable type (templates, regions, "
    + "walls, lights, sounds, drawings, notes, tiles) with full toObject() data and optional "
    + "`select` projection — validates the collections `summary` doesn't return. On Foundry v14+, "
    + "MeasuredTemplate items come back in the legacy template shape (t/x/y/distance/…) but are "
    + "stored as Region documents under the hood.",
    {
      action:   z.enum(["summary", "placeables"]).optional().describe("What to read. Default 'summary'."),
      sceneId:  z.string().optional().describe("Target scene id. Default: active scene."),
      type:     z.enum(["Token","MeasuredTemplate","Region","Wall","AmbientLight","AmbientSound","Drawing","Note","Tile"]).optional().describe("[placeables] Document type. Default 'Token'."),
      select:   z.array(z.string()).optional().describe(
        "[placeables] Optional projection — dotted field paths to keep (e.g. ['_id','name','behaviors.type']). "
        + "Cuts payload size when the caller only needs a few fields per item."
      ),
    },
    { summary: "get_scene", placeables: "get_scene_placeables" },
    "action",
    { summary: [], placeables: [] });

  // --- Token ops (merged) ---
  registerMergedTool(mcp, "token",
    "Token operations on the active scene. "
    + "action 'details' — the dense read: position, size, rotation, hidden/disposition, sight, light, "
    + "and the linked actor snapshot (system data, statuses, effects). "
    + "action 'move' — straight move or wall-aware A* path (pathed=true; canOpenDoors opens doors; "
    + "onlyUnexplored restricts to fog-covered destinations). "
    + "action 'create' — place a token for an actor (pixels x/y OR grid cells gridX/gridY). "
    + "action 'update' — patch whitelisted fields (x,y,width,height,rotation,hidden,disposition,name,"
    + "elevation,lockRotation,sort,alpha,tint). "
    + "action 'delete' — remove one or more tokens (permanent). "
    + "action 'toggleCondition' — toggle a status effect on the linked actor "
    + "(valid ids live in CONFIG.statusEffects — inspect via evaluate if unsure). "
    + "action 'target' — set the user's targets (call before an attack click; empty array clears). "
    + "action 'setLevel' — switch the viewed level of a multi-level scene (v14).",
    {
      action:        z.enum(["details", "move", "create", "update", "delete", "toggleCondition", "target", "setLevel"]).describe("Token operation."),
      tokenName:     z.string().optional().describe("[details/move/update/toggleCondition] Token id, token name, or linked actor name."),
      x:             z.number().optional().describe("[move] Target x px. [create] Pixel x — use this OR gridX."),
      y:             z.number().optional().describe("[move] Target y px. [create] Pixel y — use this OR gridY."),
      animate:       z.boolean().optional().describe("[move] Animate (default true; pathed animates only the final hop)."),
      pathed:        z.boolean().optional().describe("[move] A* pathfinding against scene walls. Default false."),
      canOpenDoors:  z.boolean().optional().describe("[move/pathed] Open closed doors along the path. Default false."),
      onlyUnexplored:z.boolean().optional().describe("[move] Reject the move if the destination is already explored (fog exploration)."),
      elevation:     z.number().optional().describe("[move/pathed] Applied to the final waypoint. [setLevel] Picks the level whose [bottom,top] contains it."),
      rotation:      z.number().optional().describe("[move/pathed] Applied to the final waypoint. [create] Rotation in degrees."),
      actorId:       z.string().optional().describe("[create] Actor whose token to place."),
      sceneId:       z.string().optional().describe("[create/setLevel] Target scene id. Default: active scene."),
      gridX:         z.number().optional().describe("[create] Grid cell column (0-indexed). Wins over x/y if both given."),
      gridY:         z.number().optional().describe("[create] Grid cell row (0-indexed)."),
      hidden:        z.boolean().optional().describe("[create] Spawn hidden to non-GMs."),
      name:          z.string().optional().describe("[create] Override the token name (defaults to actor name)."),
      updates:       z.record(z.string(), z.any()).optional().describe("[update] Fields to update (whitelisted keys only)."),
      tokens:        z.array(z.string()).optional().describe("[delete] Token ids/names to remove. [target] Token names/ids to target; empty array clears."),
      condition:     z.string().optional().describe("[toggleCondition] Condition id (e.g. 'prone', 'poisoned')."),
      active:        z.boolean().optional().describe("[toggleCondition] Force on (true) or off (false). Omit to toggle."),
      levelId:       z.string().optional().describe("[setLevel] Level document id (preferred — unambiguous). Use this OR elevation."),
      audit:         z.boolean().optional().describe(AUDIT_DESC),
    },
    { details: "get_token_details", move: "move_token", create: "create_token", update: "update_token", delete: "delete_tokens",
      toggleCondition: "toggle_token_condition", target: "target", setLevel: "set_canvas_level" },
    "action",
    { details: ["tokenName"], move: ["tokenName", "x", "y"], create: ["actorId"], update: ["tokenName", "updates"],
      delete: ["tokens"], toggleCondition: ["tokenName", "condition"], target: ["tokens"], setLevel: [] });

  // --- Spatial grid query (structured alternative to screenshot-based spatial reasoning) ---
  registerRoutedTool(mcp, "query_grid",
    "Query spatial grid state as structured data — the video-game approach. Returns per-cell booleans for explored (fog), visible (current line-of-sight), and occupied (token present). Pass either `cells` (array of {gx,gy} grid coords) or `region` ({minGX, minGY, maxGX, maxGY}) to query a rectangular area. Grid coords are 0-indexed; pixel centers are returned for each cell. "
    + "Use this instead of screenshot for spatial reasoning — it's cheaper, faster, "
    + "and deterministic.",
    {
      cells:  z.array(z.object({ gx: z.number(), gy: z.number() })).optional().describe("Explicit grid cells to query. Mutually exclusive with `region`."),
      region: z.object({ minGX: z.number(), minGY: z.number(), maxGX: z.number(), maxGY: z.number() }).optional().describe("Bounding box in grid coords (inclusive). Max 2500 cells."),
    }, "query_grid");

  // Merged: screenshot (canvas), screenshot_dom (dom), capture_scene (scene_grid).
  // All three return MCP image content via callFoundryImage, so this uses a
  // custom callback rather than registerMergedTool (which returns text only).
  registerRawTool(mcp, "screenshot",
    "Capture a Foundry image. The `target` selects what to capture and which params apply:\n"
    + "• target 'canvas' (default) → the live PIXI game canvas (map + tokens) as a downscaled JPEG. "
    + "Uses scale (0.1–1.0, default 0.5), quality (0.1–1.0, default 0.7), format ('jpeg'|'png', default 'jpeg'). "
    + "Does NOT capture DOM overlays (sheets/HUD).\n"
    + "• target 'dom' → a DOM element (character sheets, HUD, chat cards, app windows) via html2canvas. "
    + "Uses selector (CSS, default 'body'), scale (default 0.75), quality (default 0.8), format ('png'|'jpeg', "
    + "default 'png'). Fills the gap 'canvas' can't — PIXI-only never captures DOM. html2canvas loads lazily "
    + "from a CDN on first use.\n"
    + "• target 'scene_grid' → the active scene canvas as a base64 WebP with a coordinate grid overlay "
    + "(gx,gy labels per cell), useful for spatial reasoning. Takes no extra capture params.\n"
    + "• target 'cdp' → a DOM element captured via Chrome DevTools Protocol (pixel-perfect, "
    + "no html2canvas approximations). Uses selector (CSS, required), scale (default 2.0, controls "
    + "output resolution multiplier). Captures the browser's actual composited output — form inputs, "
    + "fonts, and CSS render exactly as the user sees them. Requires the bridge Chromium to be "
    + "running on port 9222.",
    {
      target:   z.enum(["canvas", "dom", "scene_grid", "cdp"]).optional().describe(
        "What to capture: 'canvas' (PIXI game canvas, default), 'dom' (a DOM element via html2canvas), "
        + "'scene_grid' (scene canvas with a coordinate grid overlay), "
        + "or 'cdp' (a DOM element via Chrome DevTools Protocol — pixel-perfect browser rendering)."),
      scale:    z.number().optional().describe("[canvas/dom/cdp] Resize factor (0.1–1.0 for canvas, 0.1–1.0 for dom, 1.0–4.0 for cdp). Default 0.5 (canvas) / 0.75 (dom) / 2.0 (cdp)."),
      quality:  z.number().optional().describe("[canvas/dom] JPEG quality (0.1–1.0). Default 0.7 (canvas) / 0.8 (dom). Ignored for PNG."),
      format:   z.enum(["jpeg", "png"]).optional().describe("[canvas/dom] Output format. Default 'jpeg' (canvas) / 'png' (dom)."),
      selector: z.string().optional().describe("[dom/cdp] CSS selector of the element to capture. Default: 'body'."),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async (p) => {
      const { target = "canvas", targetUser, selector, scale, quality, format } = p;
      if (target === "dom") {
        const toolParams = {};
        if (selector !== undefined) toolParams.selector = selector;
        if (scale    !== undefined) toolParams.scale    = scale;
        if (quality  !== undefined) toolParams.quality  = quality;
        if (format   !== undefined) toolParams.format   = format;
        return callFoundryImage("screenshot_dom", toolParams,
          d => `DOM screenshot of \`${d.selector}\` (${d.element.tag}${d.element.id ? "#"+d.element.id : ""}) — ${d.width}×${d.height} ${d.mimeType}`,
          targetUser);
      }
      if (target === "scene_grid") {
        return callFoundryImage("capture_scene", {},
          d => `Scene "${d.sceneName}" [${d.sceneId}] — ${d.width}×${d.height} ${d.mimeType} with grid overlay`,
          targetUser);
      }
      if (target === "cdp") {
        if (!selector) return { content: [{ type: "text", text: "Error: 'selector' is required for target 'cdp'" }] };
        try {
          const data = await cdpScreenshot(selector, {
            scale: scale ?? 2,
            format: format ?? "png",
            quality,
          });
          if (data.error) return { content: [{ type: "text", text: `CDP screenshot error: ${data.error}` }] };
          return {
            content: [
              { type: "image", data: data.image, mimeType: data.mimeType },
              { type: "text",  text: `CDP screenshot of \`${data.selector}\` (${data.element.tag}${data.element.id ? "#" : ""}) — ${data.width}×${data.height} ${data.mimeType}` },
            ],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `CDP screenshot failed: ${err.message}` }] };
        }
      }
      // target === "canvas"
      const toolParams = {};
      if (scale   !== undefined) toolParams.scale   = scale;
      if (quality !== undefined) toolParams.quality = quality;
      if (format  !== undefined) toolParams.format  = format;
      return callFoundryImage("screenshot", toolParams,
        d => `Canvas screenshot — ${d.width}×${d.height} ${d.mimeType}`, targetUser);
    });
}