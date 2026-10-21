/**
 * What a non-GM bridge's reads return. Pure: no Foundry globals, unit-tested
 * from server/test.
 *
 * Foundry sends every client the full source of every document; sheets hide
 * unrevealed secrets only when they render (enrichHTML `secrets: isOwner`). A
 * player's bridge reads that source, so its reads apply the same rule here.
 */

// A quote opens a value only right after `=`, as in the browser; anywhere else
// (`data-n=don't`) it is an ordinary character, so it cannot run the tag on
// past its `>` and swallow the sections after it.
const SECTION_TAG = /<(\/?)section\b(?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=(?!\s*["'])|["'])*>/gi;
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

/** Tokens of a snapshot `select` path: dotted keys, `[N]` and `[*]` (or `[]`). */
export const pathTokens = (path) => String(path).match(/\[[^\]]*\]|[^.\[\]]+/g) || [];

const tokenKind = (t) => (t === "[*]" || t === "[]" ? "all" : /^\[\d+\]$/.test(t) ? "index" : "key");

/**
 * forViewer for a value read at `path` of a document: the value is filtered as
 * if it sat at that path, so `flags.gm-notes`, `ownership.<id>` or
 * `system.activities` get the same rule as in a full read.
 */
export function forViewerAt(path, value, viewer) {
  if (viewer.isGM) return value;
  const toks = pathTokens(path);
  const nest = (i, v) => {
    if (i === toks.length) return v;
    const kind = tokenKind(toks[i]);
    if (kind === "key") return { [toks[i]]: nest(i + 1, v) };
    if (kind === "index") return [nest(i + 1, v)];
    return Array.isArray(v) ? v.map((x) => nest(i + 1, x)) : v;
  };
  const unnest = (i, v) => {
    if (i === toks.length || v == null) return v;
    const kind = tokenKind(toks[i]);
    if (kind === "key") return unnest(i + 1, v[toks[i]]);
    if (kind === "index") return unnest(i + 1, v[0]);
    return Array.isArray(v) ? v.map((x) => unnest(i + 1, x)) : v;
  };
  return unnest(0, forViewer(nest(0, value), viewer));
}

/**
 * A chat message's HTML as this viewer's chat log shows it, or null when core
 * hides its content (blind rolls, others' whispers: ChatMessage#isContentVisible;
 * GM reads stay untouched). Secrets show only to owners of the speaker's actor,
 * or the GM when there is none.
 */
export function chatContent(msg, isGM) {
  if (!isGM && msg.isContentVisible === false) return null;
  return (msg.speakerActor?.isOwner ?? isGM) ? msg.content : removeSecrets(msg.content);
}
