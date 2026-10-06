/**
 * design_preview — open (or close) the design-harness live preview window.
 *
 * The server's preview_fixture tool renders a fixture offline and sends the
 * compiled markup here as DATA. This replaces driving the same steps through
 * `evaluate`, which needed the server's eval gate, was refused over the relay,
 * and ran caller-written JavaScript for what is a fixed sequence of calls.
 *
 * It is a UI-only, transient window: no world document is read or written, so
 * it deliberately sits outside runAuditedMutation and the read-only toggle
 * ("Allow AI to modify the world" guards the WORLD; a preview must keep working
 * in a read-only session — that is when a designer is looking).
 *
 * Why this is not a script-execution primitive: the markup goes to DialogV2 as a
 * STRING, and DialogV2 runs string content through foundry.utils.cleanHTML
 * (client/applications/api/dialog.mjs) — allowlisted tags and attributes, no
 * script, no event-handler attributes, no javascript: URLs. Do not pass an
 * element or a pre-built node here: DialogV2 skips cleaning for those.
 */

export const PREVIEW_WINDOW_ID = "mcp-fixture-preview";

const MAX_HTML = 1_000_000;
const MAX_CSS = 500_000;

// DialogV2 FORCES a footer button bar (it refuses to construct without one),
// which the real window will never have; hide it so the preview is judged on the
// window, not on chrome it will not ship. The title-bar X is the real close.
const PREVIEW_CHROME_CSS = `\n.application#${PREVIEW_WINDOW_ID} .form-footer { display: none; }\n`;

function closePreview() {
  const prior = foundry.applications.instances.get(PREVIEW_WINDOW_ID);
  document.getElementById(`${PREVIEW_WINDOW_ID}-css`)?.remove();
  return prior;
}

/** @returns {string|null} an error message, or null when the params are acceptable. */
export function validatePreviewParams({ html, css, title, classes, width }) {
  if (typeof html !== "string" || !html.length) return "`html` (the fixture's compiled markup) is required.";
  if (html.length > MAX_HTML) return `\`html\` is larger than ${MAX_HTML} characters.`;
  if (css !== undefined && (typeof css !== "string" || css.length > MAX_CSS)) return `\`css\` must be a string under ${MAX_CSS} characters.`;
  if (title !== undefined && typeof title !== "string") return "`title` must be a string.";
  if (classes !== undefined && !(Array.isArray(classes) && classes.every((c) => typeof c === "string" && /^[\w-]+$/.test(c)))) {
    return "`classes` must be an array of CSS class names.";
  }
  if (width !== undefined && !(Number.isFinite(Number(width)) && Number(width) > 0)) return "`width` must be a positive number.";
  return null;
}

/**
 * @param {object} params
 * @param {boolean} [params.close]  close the preview window and return
 * @param {string}  params.html     the fixture's compiled markup
 * @param {string}  [params.css]    the fixture's own CSS
 * @param {string}  [params.title]
 * @param {string[]} [params.classes]
 * @param {number}  [params.width]  px; default 600
 */
export async function designPreview(params = {}) {
  if (params.close) {
    const prior = closePreview();
    if (prior) await prior.close();
    return { closed: !!prior };
  }

  const bad = validatePreviewParams(params);
  if (bad) return { opened: false, error: bad };
  if (!game?.ready) return { opened: false, error: "game.ready is false — wait for the world to finish loading" };

  const { html, css = "", classes = [] } = params;
  const title = params.title ?? "Fixture preview";
  const width = Math.round(Number(params.width) || 600);

  const prior = closePreview();
  if (prior) await prior.close();

  const app = new foundry.applications.api.DialogV2({
    id: PREVIEW_WINDOW_ID,
    position: { width },
    window: { title, resizable: true },
    content: html, // a string on purpose: see the header comment
    buttons: [{ action: "close", label: game.i18n.localize("APPLICATION.TOOLS.Close"), default: true }],
  });
  const style = document.createElement("style");
  style.id = `${PREVIEW_WINDOW_ID}-css`;
  style.textContent = css + PREVIEW_CHROME_CSS;
  document.head.appendChild(style);
  await app.render(true);
  app.element.classList.add(...classes);

  // Fixture classes can carry context-dependent sizing (e.g. core's
  // .combat-sidebar.active { height: 0 } for the sidebar tab). A dialog is not
  // those contexts, so pin an explicit content-driven height inline — inline
  // beats any stylesheet rule, layered or not — and cap it to the viewport.
  app.element.style.height = "auto";
  app.element.style.maxHeight = `${Math.round((window.innerHeight || 800) * 0.85)}px`;
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { opened: true, id: PREVIEW_WINDOW_ID, title, classes, width };
}
