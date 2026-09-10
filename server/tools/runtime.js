/**
 * Runtime + DOM tools — `evaluate`, `click`, `simulate_dialog_response`,
 * `get_console_errors`. These act on the running Foundry runtime/DOM
 * rather than persisted data.
 */
import { z }                  from "zod";
import { registerRoutedTool, registerRawTool, registerMergedTool, TARGET_USER_DESC } from "./_helpers.js";
import { ALLOW_EVAL }          from "../lib/config.js";
import { callFoundry }         from "../lib/foundry-rpc.js";

const MIN_EVALUATE_TIMEOUT_MS = 5_000;
const MAX_EVALUATE_TIMEOUT_MS = 180_000;

export function createEvaluateHandler(callFoundryImpl = callFoundry) {
  return async ({ expression, background = false, targetUser, timeoutMs }) => {
    const clampedTimeout = timeoutMs === undefined
      ? undefined
      : Math.min(Math.max(Math.trunc(timeoutMs), MIN_EVALUATE_TIMEOUT_MS), MAX_EVALUATE_TIMEOUT_MS);
    return callFoundryImpl("evaluate", { expression, ...(background ? { background: true } : {}) }, targetUser, clampedTimeout);
  };
}

export function createJobResultHandler(callFoundryImpl = callFoundry) {
  return async ({ targetUser, waitMs = 0, ...params }) => {
    const bridgeTimeoutMs = Math.max(15_000, Math.min(Math.max(Math.trunc(waitMs), 0), 10_000) + 5_000);
    return callFoundryImpl("job_result", { ...params, waitMs }, targetUser, bridgeTimeoutMs);
  };
}

export function registerRuntimeTools(mcp) {
  // --- Console errors ---
  registerRoutedTool(mcp, "get_console_errors",
    "Get recent console errors and warnings from the Foundry client. Invaluable for debugging. " +
    "Returns { bufferSize, bufferCapacity, returned, entries[] }. Buffer holds up to 1000 entries. " +
    "Defaults to the last 60 seconds of entries when sinceMs is omitted (was previously 'all', which was too noisy).",
    {
      count:   z.number().optional().describe("Number of recent entries. Default: all matching the time window (max 1000)"),
      sinceMs: z.number().optional().describe("Only entries from the last N ms. Default 60000 (last minute). Pass 0 to disable the filter."),
      level:   z.enum(["error", "warn"]).optional().describe("Filter by level."),
    });

  // --- Evaluate (opt-in: requires FOUNDRY_MCP_ALLOW_EVAL=1) ---
  if (ALLOW_EVAL) {
    registerRawTool(mcp, "evaluate",
      "LAST-RESORT power tool — prefer a dedicated tool when one exists. The "
      + "dedicated tools (e.g. `apply_damage`, `token`, `use_item`, "
      + "`actor_write`, `combat`) encode system correctness "
      + "(HP clamping, wall-aware movement, attack/crit logic) and carry "
      + "audit/undo that hand-written JS skips — reaching for `evaluate` first "
      + "tends to produce wrong state. Use this only when no dedicated tool fits.\n\n"
      + "Evaluate arbitrary JavaScript in the live Foundry VTT context. "
      + "Has access to `game`, `canvas`, and `ui` globals. "
      + "Write the body of an async function; `return` to send data back; "
      + "`await` works.\n\n"
      + "Gotchas:\n"
      + "• Returns are JSON-stringified — Foundry document objects (Actor, "
      + "Item, ChatMessage, etc.) serialize as `{}`. Wrap them in `.toObject()` "
      + "or pull specific fields explicitly.\n"
      + "• Map / Set / DOM nodes / functions silently drop. Convert to plain "
      + "structures: `[...map.entries()]`, `[...set]`, `el.outerHTML`, etc.\n"
      + "• To inspect a tool/object surface, enumerate explicitly: "
      + "`Object.keys(obj).map(k => ({ k, t: typeof obj[k] }))`.\n"
      + "• Response includes `evalMs` so you can tell whether a slow call is "
      + "the bridge or your code.",
       {
         expression: z.string().describe(
           "JS to evaluate (body of an async function with game/canvas/ui in scope)."
         ),
         timeoutMs: z.number().optional().describe(
           "Server-side wait limit in milliseconds. Values are clamped to 5000-180000. "
           + "Omit for the default 15000ms timeout."
         ),
         background: z.boolean().optional().describe(
           "Start the evaluation as a background job and return a jobId immediately. Default false."
         ),
         targetUser: z.string().optional().describe(TARGET_USER_DESC),
       },
       createEvaluateHandler());

    registerRawTool(mcp, "job_result",
      "Poll or read a background evaluate job. Completed small results return inline; "
      + "large results return bounded JSON chunks. Results remain available until TTL "
      + "expiry or an explicit delete. Running JavaScript cannot be canceled safely.",
      {
        jobId: z.string().describe("Job/result handle returned by evaluate."),
        waitMs: z.number().int().min(0).max(10_000).optional().describe(
          "Wait up to this many milliseconds for a running job before returning status. Default 0."
        ),
        offset: z.number().int().min(0).optional().describe("Character offset for a large JSON result. Default 0."),
        length: z.number().int().min(1).max(65_536).optional().describe("Maximum JSON characters to return. Default 65536."),
        delete: z.boolean().optional().describe("Delete a settled job/result instead of reading it."),
        targetUser: z.string().optional().describe(TARGET_USER_DESC),
      },
      createJobResultHandler());
  }

  // --- Interact (merged: click / simulate_dialog_response) ---
  registerMergedTool(mcp, "interact",
    "Simulate user interactions with the live UI. "
    + "action 'click' — click a DOM element by CSS selector (character-sheet buttons, chat-card "
    + "actions, any app button including Dialogs with stable selectors); renders an actor sheet "
    + "first via openActor; combines with rig to force dice results; captures chat messages "
    + "created during the click. "
    + "action 'dialog' — click a button on the topmost open DialogV2 by label (contains, "
    + "case-insensitive) or zero-based index — the fallback when a dialog has no stable selector.",
    {
      action:   z.enum(["click", "dialog"]).describe("Interaction type."),
      selector: z.string().optional().describe("[click] CSS selector of the element to click, e.g. '[data-action=\"vce-bless-mode\"]' or 'dialog button.dialog-button[data-action=\"yes\"]'."),
      rig:      z.array(z.number()).optional().describe("[click] Forced face values for dice rolled during the click."),
      openActor:z.string().optional().describe("[click] If set, render this actor's sheet first so its buttons exist in the DOM."),
      waitMs:   z.number().optional().describe("[click] Milliseconds to wait for async chat messages after the click. Default 400."),
      label:    z.string().optional().describe("[dialog] Match the first button whose visible text contains this (case-insensitive). Mutually exclusive with index."),
      index:    z.number().optional().describe("[dialog] Zero-based button index. Use when labels are ambiguous."),
    },
    { click: "click", dialog: "simulate_dialog_response" },
    "action",
    { click: ["selector"], dialog: [] });
}
