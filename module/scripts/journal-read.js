/**
 * Read-side helpers for journals and prepared (derived) document data.
 *
 *   - htmlToMarkdown — walks a parsed DOM (DOMParser output in the browser),
 *     never regex over HTML, so nesting, tables and secrets come out right.
 *   - listJournals / getJournal — bridge handlers behind `list {type:"journal"}`
 *     and `document {action:"journal"}`. Paginated as {total, offset, count,
 *     items}; `truncated` is always present and a `note` says how to continue.
 *   - derivedView — `document {derived:true}`: toObject(false).system,
 *     appliedEffects and getRollData() (the last carries non-schema derived
 *     values such as dnd5e abilities.*.mod that toObject(false) drops).
 */

const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE",
  "FIGURE", "FIGCAPTION", "MAIN", "NAV", "DL", "DT", "DD", "DETAILS", "SUMMARY"]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

export function htmlToMarkdown(root, { secrets = false } = {}) {
  return walk(root, { secrets, pre: false })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function kids(node, ctx) {
  return [...(node.childNodes ?? [])].map((n) => walk(n, ctx)).join("");
}

function elementKids(node, tags) {
  return [...(node.childNodes ?? [])].filter((n) => n.nodeType === 1 && tags.includes(n.tagName.toUpperCase()));
}

// Keep the whitespace around an inline span outside its markers: "a<b> x </b>c" -> "a **x** c".
function wrap(inner, mark) {
  const [, lead, body, trail] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return body ? `${lead}${mark}${body}${mark}${trail}` : inner;
}

const block = (s) => `\n\n${s}\n\n`;
const oneLine = (s) => s.replace(/\s*\n+\s*/g, " ").trim();

function walk(node, ctx) {
  if (node.nodeType === 3) return ctx.pre ? node.textContent : node.textContent.replace(/\s+/g, " ");
  if (node.nodeType === 9 || node.nodeType === 11) return kids(node, ctx);
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toUpperCase();
  if (SKIP.has(tag)) return "";
  const classes = (node.getAttribute("class") || "").split(/\s+/);
  if (classes.includes("secret")) {
    if (!ctx.secrets) return "";
    return block(`> **Secret:** ${kids(node, ctx).trim().replace(/\n/g, "\n> ")}`);
  }
  if (/^H[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${oneLine(kids(node, ctx))}`);
  switch (tag) {
    case "BR": return "\n";
    case "HR": return block("---");
    case "STRONG": case "B": return wrap(kids(node, ctx), "**");
    case "EM": case "I": return wrap(kids(node, ctx), "*");
    case "S": case "DEL": return wrap(kids(node, ctx), "~~");
    case "CODE": return ctx.pre ? kids(node, ctx) : wrap(kids(node, ctx), "`");
    case "PRE": return block("```\n" + kids(node, { ...ctx, pre: true }).replace(/\n$/, "") + "\n```");
    case "BLOCKQUOTE": return block("> " + kids(node, ctx).trim().replace(/\n/g, "\n> "));
    case "IMG": {
      const src = node.getAttribute("src");
      return src ? `![${node.getAttribute("alt") || ""}](${src})` : "";
    }
    case "A": {
      const text = oneLine(kids(node, ctx));
      const uuid = node.getAttribute("data-uuid");
      if (uuid) return `@UUID[${uuid}]{${text}}`;
      const href = node.getAttribute("href");
      return href && text && !/^javascript:/i.test(href) && href !== "#" ? `[${text}](${href})` : text;
    }
    case "UL": case "OL": {
      const items = elementKids(node, ["LI"]).map((li, i) => {
        const marker = tag === "OL" ? `${i + 1}. ` : "- ";
        const text = kids(li, ctx).trim().replace(/\n{2,}/g, "\n");
        return marker + text.replace(/\n/g, "\n" + " ".repeat(marker.length));
      });
      return block(items.join("\n"));
    }
    case "TABLE": {
      const rows = tableRows(node).map((tr) =>
        elementKids(tr, ["TH", "TD"]).map((c) => oneLine(kids(c, ctx)).replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
      return block([line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
    default: {
      const inner = kids(node, ctx);
      return BLOCK.has(tag) ? block(inner.trim()) : inner;
    }
  }
}

// TR elements of this table only (through THEAD/TBODY/TFOOT, not into nested tables).
function tableRows(node) {
  return [...(node.childNodes ?? [])].flatMap((n) => {
    if (n.nodeType !== 1) return [];
    const t = n.tagName.toUpperCase();
    if (t === "TR") return [n];
    return ["THEAD", "TBODY", "TFOOT"].includes(t) ? tableRows(n) : [];
  });
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

const canSee = (doc, level) => typeof doc.testUserPermission !== "function" || doc.testUserPermission(game.user, level);
const intIn = (v, dflt, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt));
const textEditor = () => foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;

function visiblePages(entry) {
  return [...entry.pages.contents].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).filter((p) => canSee(p, "OBSERVER"));
}

async function pageMarkdown(page, { enrich = false, secrets = false } = {}) {
  if (page.type === "image") return page.src ? `![${page.image?.caption || page.name}](${page.src})` : "";
  if (page.type === "video" || page.type === "pdf") return page.src ? `[${page.name}](${page.src})` : "";
  let html = page.text?.content ?? "";
  if (!html) return "";
  // A page switched to the Markdown sheet (JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN) already stores Markdown.
  if (page.text.format === 2) return html;
  // Core shows secrets only to the page's owners; a caller cannot ask for more.
  secrets = secrets === true && page.isOwner === true;
  if (enrich) html = await textEditor().enrichHTML(html, { secrets, relativeTo: page, async: true });
  return htmlToMarkdown(new DOMParser().parseFromString(html, "text/html").body, { secrets });
}

function paginate(rows, offset, limit) {
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  const more = next < rows.length;
  return {
    total: rows.length, offset, count: items.length, items, truncated: more,
    ...(more ? { nextOffset: next, note: `${rows.length - next} more not shown; call again with offset=${next}.` } : {}),
  };
}

function snippet(text, idx, len) {
  const start = Math.max(0, idx - 60);
  return (start ? "…" : "") + text.slice(start, idx + len + 60).replace(/\s+/g, " ") + (idx + len + 60 < text.length ? "…" : "");
}

/** list {type:"journal"} — entries with their pages; `query` searches names and page text. */
export async function listJournals(params = {}) {
  let entries = game.journal.contents.filter((j) => canSee(j, "LIMITED"));
  if (params.folder) entries = entries.filter((j) => j.folder?.name === params.folder);
  const q = params.query?.trim().toLowerCase();
  const rows = [];
  for (const j of entries) {
    const pages = visiblePages(j);
    const row = { id: j.id, name: j.name, folder: j.folder?.name ?? null };
    if (!q) {
      rows.push({ ...row, pages: pages.map((p) => ({ id: p.id, name: p.name, type: p.type })) });
      continue;
    }
    const matches = [];
    for (const p of pages) {
      const text = await pageMarkdown(p, { secrets: params.secrets });
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) matches.push({ pageId: p.id, pageName: p.name, snippet: snippet(text, idx, q.length) });
      else if (p.name.toLowerCase().includes(q)) matches.push({ pageId: p.id, pageName: p.name });
    }
    if (matches.length || j.name.toLowerCase().includes(q)) rows.push({ ...row, matches });
  }
  return paginate(rows, intIn(params.offset, 0, 0, Infinity), intIn(params.limit, 50, 1, 500));
}

async function findEntry({ id, name, pack }) {
  if (!pack) return id ? game.journal.get(id) : game.journal.getName(name);
  const p = game.packs.get(pack);
  if (!p) return null;
  if (id) return p.getDocument(id);
  const index = p.index.size ? p.index : await p.getIndex();
  const hit = [...index.values()].find((e) => e.name?.toLowerCase() === String(name).toLowerCase());
  return hit ? p.getDocument(hit._id) : null;
}

/**
 * document {action:"journal"} — one entry's pages as Markdown. Pages are
 * paginated (offset/limit); `maxChars` caps the reply. A page that alone
 * overflows the cap is cut and the note gives the textOffset to resume at.
 */
export async function getJournal(params = {}) {
  if (!params.id && !params.name) return { error: "journal read needs `id` or `name`." };
  const entry = await findEntry(params);
  if (!entry || entry.documentName !== "JournalEntry" || !canSee(entry, "LIMITED")) {
    return { error: `Journal entry not found: ${params.id || params.name}${params.pack ? ` in ${params.pack}` : ""}` };
  }
  let pages = visiblePages(entry);
  if (params.page) {
    pages = pages.filter((p) => p.id === params.page || p.name === params.page);
    if (!pages.length) return { error: `Page not found in "${entry.name}": ${params.page}` };
  }
  const offset = intIn(params.offset, 0, 0, Infinity);
  const limit = intIn(params.limit, 20, 1, 100);
  const maxChars = intIn(params.maxChars, 20000, 500, 200000);
  const textOffset = params.page ? intIn(params.textOffset, 0, 0, Infinity) : 0;

  const items = [];
  let used = 0, note = null;
  for (const p of pages.slice(offset, offset + limit)) {
    const full = await pageMarkdown(p, params);
    let markdown = full.slice(textOffset);
    const room = maxChars - used;
    if (markdown.length > room) {
      if (items.length) { note = `Stopped at maxChars=${maxChars} before page "${p.name}"; call again with offset=${offset + items.length}.`; break; }
      markdown = markdown.slice(0, room);
      const resume = textOffset + room;
      note = `Page "${p.name}" cut at character ${resume} of ${full.length}; call again with page="${p.id}", textOffset=${resume} (the next page is offset=${offset + 1}).`;
      items.push({ id: p.id, name: p.name, type: p.type, chars: full.length, textOffset, markdown, cut: true });
      break;
    }
    used += markdown.length;
    items.push({ id: p.id, name: p.name, type: p.type, chars: full.length, ...(textOffset ? { textOffset } : {}), markdown });
  }
  const next = offset + items.length;
  if (!note && next < pages.length) note = `${pages.length - next} more page(s); call again with offset=${next}.`;
  return {
    id: entry.id, uuid: entry.uuid, name: entry.name, folder: entry.folder?.name ?? null,
    total: pages.length, offset, count: items.length, items,
    truncated: Boolean(note), ...(note ? { nextOffset: next, note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Derived (prepared) data
// ---------------------------------------------------------------------------

/**
 * JSON-safe deep copy: cycles and over-deep branches become markers, nested
 * Documents become their uuid, Sets/Maps become arrays/objects. DataModels
 * are walked by their own properties (their toJSON returns source and would
 * drop the derived values this exists to show).
 */
export function jsonSafe(value, depth = 0, ancestors = new Set()) {
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth > 12) return "[MaxDepth]";
  if (value.documentName && typeof value.uuid === "string" && depth > 0) return value.uuid;
  ancestors.add(value);
  try {
    if (Array.isArray(value) || value instanceof Set) return [...value].map((v) => jsonSafe(v, depth + 1, ancestors) ?? null);
    if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, jsonSafe(v, depth + 1, ancestors)]));
    if (typeof value.toJSON === "function" && !("_source" in value)) return jsonSafe(value.toJSON(), depth + 1, ancestors);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "parent") continue;
      const s = jsonSafe(v, depth + 1, ancestors);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function derivedView(doc) {
  return {
    id: doc.id, uuid: doc.uuid, name: doc.name, type: doc.type, img: doc.img,
    system: jsonSafe(doc.toObject(false).system),
    ...(doc.appliedEffects ? {
      appliedEffects: [...doc.appliedEffects].map((e) => jsonSafe({
        id: e.id, name: e.name, origin: e.origin ?? null, statuses: e.statuses, changes: e.changes ?? e.system?.changes,
      })),
    } : {}),
    rollData: typeof doc.getRollData === "function" ? jsonSafe(doc.getRollData()) : null,
  };
}
