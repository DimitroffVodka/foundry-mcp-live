/**
 * What a non-GM bridge's reads return. Pure: no Foundry globals, unit-tested
 * from server/test.
 *
 * Foundry sends every client the full source of every document; sheets hide
 * unrevealed secrets only when they render (enrichHTML `secrets: isOwner`). A
 * player's bridge reads that source, so its reads apply the same rule here.
 */

const SECTION_TAG = /<(\/?)section\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const CLASS_ATTR = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Remove unrevealed `<section class="secret">` blocks, as core's enrichHTML
 * does with `secrets: false` (`section.secret:not(.revealed)`). Nested
 * sections are counted; an unclosed secret drops the rest of the string.
 */
export function removeSecrets(html) {
  if (typeof html !== "string" || !html.includes("secret")) return html;
  let out = "", from = 0, depth = 0;
  for (const m of html.matchAll(SECTION_TAG)) {
    if (m[1]) {
      if (depth && --depth === 0) from = m.index + m[0].length;
      continue;
    }
    if (depth) { depth++; continue; }
    const c = m[0].match(CLASS_ATTR);
    const classes = (c ? c[1] ?? c[2] ?? c[3] : "").split(/\s+/);
    if (classes.includes("secret") && !classes.includes("revealed")) {
      out += html.slice(from, m.index);
      depth = 1;
    }
  }
  return depth ? out : out + html.slice(from);
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A read result as this viewer may see it. GMs get `data` untouched. For
 * everyone else: unrevealed secrets go unless they own the document; flags of
 * namespaces outside `keepFlags` go (`keepFlags: true` keeps all); every
 * `ownership` map becomes just the viewer's own entry. Nothing below a
 * `system` key is treated as flags/ownership: that is the system's own data.
 *
 * @param {unknown} data  toObject() output or another JSON-safe read result
 * @param {{isGM: boolean, isOwner: boolean, userId?: string, level?: number|null,
 *          keepFlags?: string[]|true}} viewer
 */
export function forViewer(data, viewer) {
  if (viewer.isGM) return data;
  const keep = viewer.keepFlags ?? [];
  const walk = (v, inSystem) => {
    if (typeof v === "string") return viewer.isOwner ? v : removeSecrets(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, inSystem));
    if (!isPlain(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!inSystem && k === "ownership" && isPlain(x)) {
        out[k] = viewer.userId ? { [viewer.userId]: viewer.level ?? null } : {};
      } else if (!inSystem && k === "flags" && isPlain(x) && keep !== true) {
        out[k] = Object.fromEntries(Object.entries(x).filter(([ns]) => keep.includes(ns)).map(([ns, f]) => [ns, walk(f, true)]));
      } else {
        out[k] = walk(x, inSystem || k === "system");
      }
    }
    return out;
  };
  return walk(data, false);
}
