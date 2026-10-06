/**
 * Server-local tools — these don't proxy to the Foundry bridge. They run
 * entirely in the MCP server process and inspect / orchestrate bridge
 * connections directly.
 *
 *   - `list_connected_bridges` — discovery affordance for `targetUser`
 *   - `reload_foundry`         — orchestrated reload + reconnect + ready wait
 */
import { execFile, spawn }                   from "node:child_process";
import { randomUUID }                        from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir }                   from "node:os";
import path                                  from "node:path";
import { promisify }                         from "node:util";
import { z }                                 from "zod";
import { bridges, lastSeenBridges, reconnectWaiters, routeBridge } from "../lib/bridges.js";
import { ALLOW_EVAL, FOUNDRY_URLS, RELAUNCH_CONFIG } from "../lib/config.js";
import { diagnoseBridgeStatus }             from "../lib/bridge-status.js";
import { relaunchClient }                   from "../lib/relaunch.js";
import { requestFoundry }                   from "../lib/foundry-rpc.js";
import { cdpScreenshot }                    from "../lib/cdp-screenshot.js";
import { cropToContent, diffPng }           from "../lib/png-diff.js";
import { buildGalleryHtml, checkSummary, writeGallery } from "../lib/design-gallery.js";
import { discardVariant, writeVariant }     from "../lib/design-variant.js";
import { relayClients }                     from "../lib/relay-runtime.js";
import { registerRawTool, TARGET_USER_DESC } from "./_helpers.js";

function getBridgeDiagnosis() {
  return diagnoseBridgeStatus({
    bridges,
    lastSeenBridges,
    configuredOrigins: FOUNDRY_URLS,
  });
}

function diagnosisReply(error, diagnosis) {
  return { content: [{ type: "text", text: JSON.stringify({
    error,
    diagnosis,
  }, null, 2) }] };
}

// --- Design-harness rendering (offline, any module) -------------------------
// A design harness (a module's tools/design-harness) renders a fixture in a
// Foundry v14 window frame with no world running. `render_fixture` shells to
// its shot.mjs and returns the PNG plus the layout check. It registers only
// when the harness exists on this host (FOUNDRY_DESIGN_HARNESS overrides the
// default path); tools/*.js hot-reloads, so the env is read per call.
const execFileAsync = promisify(execFile);

export function designHarnessDir() {
  return process.env.FOUNDRY_DESIGN_HARNESS
    ?? path.join(homedir(), "git", "shadowdark-enhancer", "tools", "design-harness");
}

export function designHarnessReady() {
  return existsSync(path.join(designHarnessDir(), "shot.mjs"));
}

export function designRenderTarget({ fixture, module }) {
  const moduleDir = module ? path.resolve(module) : path.resolve(designHarnessDir(), "..", "..");
  const fixturesDir = path.join(moduleDir, "tools", "design-harness", "fixtures");
  return { moduleDir, fixturesDir, fixtureFile: path.join(fixturesDir, `${fixture}.mjs`) };
}

export function buildDesignRenderInvocation({ fixture, module, theme, width, state }, outPng) {
  const args = [path.join(designHarnessDir(), "shot.mjs"), fixture, outPng];
  if (theme) args.push(`--theme=${theme}`);
  if (width) args.push(`--w=${width}`);
  if (state) args.push(`--state=${state}`);
  // A random port: shot.mjs starts its own in-process server, and the default
  // 4177 would collide with a served harness or a concurrent render.
  const env = { ...process.env, PORT: String(41000 + Math.floor(Math.random() * 8000)) };
  if (module) env.MODULE_DIR = path.resolve(module);
  return { args, env };
}

function listFixtures(fixturesDir) {
  return readdirSync(fixturesDir).filter(f => f.endsWith(".mjs") && !f.startsWith("_")).map(f => f.slice(0, -4));
}

// Sibling checkouts of the default module that carry their own harness — what a
// model can pass as `module` without having to guess paths.
function listHarnessModules() {
  const parent = path.dirname(designRenderTarget({}).moduleDir);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(d => d.isDirectory()
        && existsSync(path.join(parent, d.name, "module.json"))
        && existsSync(path.join(parent, d.name, "tools", "design-harness", "fixtures")))
      .map(d => path.join(parent, d.name));
  } catch { return []; }
}

export function validateDesignTarget({ fixture, module }) {
  if (module && !path.isAbsolute(module)) {
    return { error: `Error: \`module\` must be an absolute path to a module checkout root (got \`${module}\`).` };
  }
  const { moduleDir, fixturesDir, fixtureFile } = designRenderTarget({ fixture, module });
  if (module && !existsSync(path.join(moduleDir, "module.json"))) {
    return { error: `Error: no module.json under ${moduleDir} — \`module\` must be a module checkout root.` };
  }
  if (!existsSync(fixturesDir)) {
    return { error: `Error: no design harness in ${moduleDir} — expected ${fixturesDir}. `
      + `Pass a module checkout that has tools/design-harness, or install the harness there first.` };
  }
  if (!fixture || !existsSync(fixtureFile)) {
    const avail = listFixtures(fixturesDir);
    const mods = module ? [] : listHarnessModules().filter(m => m !== moduleDir);
    return { error: (fixture ? `Error: no fixture \`${fixture}\` in ${fixturesDir}.` : `Pass a \`fixture\`. Module: ${moduleDir}.`)
      + (avail.length ? ` Available: ${avail.slice(0, 25).join(", ")}${avail.length > 25 ? ` (+${avail.length - 25} more)` : ""}.` : "")
      + (mods.length ? ` Other modules with a harness (pass as \`module\`): ${mods.slice(0, 8).join(", ")}${mods.length > 8 ? ` (+${mods.length - 8} more)` : ""}.` : "") };
  }
  return { moduleDir, fixturesDir, fixtureFile };
}

// --- Design-harness live preview (opens inside a running Foundry client) ----
// render_fixture shows the harness's offline replica; the live preview opens
// the same compiled markup as a real window in a connected client, so the
// actual cascade (including the unlayered stylesheet re-injection the harness
// cannot model) and theme apply. One window at a time, id-tagged so re-opening
// replaces it and closing is a single lookup.
export const PREVIEW_WINDOW_ID = "mcp-fixture-preview";

// The window's close control is the title-bar X; DialogV2 additionally FORCES a
// footer button bar (it refuses to construct without one), which the real
// window will never have. Hide that bar so a preview is judged on the window,
// not on chrome it will not ship.
const PREVIEW_CHROME_CSS = "\n.application#mcp-fixture-preview .form-footer { display: none; }\n";

export function buildPreviewOpenExpression({ html, css, title, classes, width }) {
  const name = JSON.stringify(title ?? "Fixture preview");
  const cls = JSON.stringify(Array.isArray(classes) ? classes : []);
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : 600;
  return `const id = ${JSON.stringify(PREVIEW_WINDOW_ID)};
if (!game?.ready) return { opened: false, error: "game.ready is false — wait for the world to finish loading" };
const prior = foundry.applications.instances.get(id);
if (prior) await prior.close();
document.getElementById(id + "-css")?.remove();
const app = new foundry.applications.api.DialogV2({
  id,
  position: { width: ${w} },
  window: { title: ${name}, resizable: true },
  content: ${JSON.stringify(html ?? "")},
  buttons: [{ action: "close", label: game.i18n.localize("APPLICATION.TOOLS.Close"), default: true }],
});
const style = document.createElement("style");
style.id = id + "-css";
style.textContent = ${JSON.stringify((css ?? "") + PREVIEW_CHROME_CSS)};
document.head.appendChild(style);
await app.render(true);
app.element.classList.add(...${cls});
// Fixture classes can carry context-dependent sizing (e.g. core's
// .combat-sidebar.active { height: 0 } for the sidebar tab). A dialog is not
// those contexts, so pin an explicit content-driven height inline — inline
// beats any stylesheet rule (layered or not) — and cap it to the viewport.
app.element.style.height = "auto";
app.element.style.maxHeight = Math.round((window.innerHeight || 800) * 0.85) + "px";
await new Promise((resolve) => setTimeout(resolve, 250));
return { opened: true, id, title: ${name}, classes: ${cls}, width: ${w} };`;
}

export function buildPreviewCloseExpression() {
  return `const id = ${JSON.stringify(PREVIEW_WINDOW_ID)};
const app = foundry.applications.instances.get(id);
if (app) await app.close();
document.getElementById(id + "-css")?.remove();
return { closed: !!app };`;
}

// Ask the module's design_preview handler to open/close the preview. A connected module that predates the
// handler answers "Unknown tool"; the same steps can then be driven through `evaluate` — if the server's eval
// gate allows it. The fallback exists for stale installs (the remote copy drifts); drop it once none remain.
export async function callPreview(params, fallbackExpression, userId, { request = requestFoundry, allowEval = ALLOW_EVAL } = {}) {
  try {
    const reply = await request("design_preview", params, userId);
    return reply?.result ?? reply;
  } catch (err) {
    if (!/Unknown tool/i.test(err.message)) throw err;
    if (!allowEval) {
      throw new Error("the connected Foundry module predates the design_preview handler and the server's eval gate "
        + "(FOUNDRY_MCP_ALLOW_EVAL=0) is off — deploy the current module/ to Foundry and reload the client.");
    }
    const reply = await request("evaluate", { expression: fallbackExpression() }, userId);
    return reply?.result ?? reply;
  }
}

export async function fetchFixtureFragment({ fixture, module, state }, { timeoutMs = 15_000 } = {}) {
  const port = 41000 + Math.floor(Math.random() * 8000);
  const env = { ...process.env, PORT: String(port) };
  if (module) env.MODULE_DIR = path.resolve(module);
  const child = spawn(process.execPath, [path.join(designHarnessDir(), "serve.mjs")],
    { env, cwd: homedir(), stdio: ["ignore", "ignore", "pipe"] });
  let died = null;
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  child.on("error", (err) => { died = err.message; });
  child.on("exit", (code) => { died ??= `exited with code ${code}`; });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (!died && Date.now() < deadline) {
      try { const probe = await fetch(`${base}/.harness`, { signal: AbortSignal.timeout(2000) }); if (probe.ok) { ready = true; break; } } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      throw new Error(`design harness did not start on port ${port}${died ? ` (${died})` : ` within ${timeoutMs}ms`}`
        + (stderr.trim() ? `:\n${stderr.trim().split("\n").slice(-6).join("\n")}` : ""));
    }
    const url = `${base}/w/${encodeURIComponent(fixture)}?frag=1${state ? `&state=${encodeURIComponent(state)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`harness fragment request failed: HTTP ${res.status}`);
    return await res.json();
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// One offline render. Never throws: a failure comes back as `error` so a
// compare can still show the other side.
async function renderFixtureOnce({ fixture, module, theme, width, state }) {
  const outPng = path.join(tmpdir(), `design-fixture-${fixture}-${theme}-${randomUUID()}.png`);
  const inv = buildDesignRenderInvocation({ fixture, module, theme, width, state }, outPng);
  try {
    const { stdout } = await execFileAsync(process.execPath, inv.args,
      { env: inv.env, cwd: homedir(), timeout: 90_000, maxBuffer: 8 << 20 });
    // shot.mjs prints its server banner, then the PNG path, then the check.
    const check = stdout.split("\n")
      .filter(l => l.trim() && !l.startsWith("design harness:") && l.trim() !== outPng)
      .join("\n").trim();
    const png = existsSync(outPng) ? readFileSync(outPng) : null;
    if (!check || check.startsWith("(no check ran)")) {
      return { png, check: null, error: `render failed — no layout check was produced (the image, if any, is likely the harness error page). On the server host run: node ${path.join(designHarnessDir(), "shot.mjs")} ${fixture} — it prints the stack.` };
    }
    return { png, check, error: null };
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split("\n").slice(-6).join("\n");
    return { png: null, check: null, error: `render_fixture failed: ${detail}` };
  } finally {
    try { unlinkSync(outPng); } catch { /* already gone */ }
  }
}

// Byte equality is exact but too strict: a checkout rendered against itself can
// differ by ±1 on a few anti-aliased corner pixels. Decode and count real
// movement instead; fall back to byte equality for PNGs we cannot decode.
// `highlight` is a PNG showing where the pixels moved, when some did.
function pixelVerdict(base, head) {
  if (base.png.equals(head.png)) return { text: "pixels identical" };
  const d = diffPng(base.png, head.png, { highlight: true });
  if (!d) return { text: "pixels differ (byte-level; images not decodable for a finer diff)" };
  if (d.sizeChanged) return { text: `size changed ${d.a} -> ${d.b}` };
  if (!d.changed) return { text: "pixels identical (within anti-aliasing noise)" };
  const pct = d.changed / d.total * 100;
  return {
    text: `${d.changed} px changed (${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%), in a ${d.bbox.w}x${d.bbox.h} area at ${d.bbox.x},${d.bbox.y}`,
    highlight: d.highlight,
  };
}

// What a compare says about one theme: did the pixels move, did the check change.
export function compareRuns(base, head) {
  if (base.error || head.error || !base.png || !head.png) return { text: "not comparable — one side failed to render." };
  const layout = base.check === head.check
    ? "layout check unchanged"
    : `layout check CHANGED\n  base: ${base.check.replace(/\n/g, " | ")}\n  head: ${head.check.replace(/\n/g, " | ")}`;
  const pixels = pixelVerdict(base, head);
  return { text: `${pixels.text}; ${layout}`, highlight: pixels.highlight };
}
export const compareVerdict = (base, head) => compareRuns(base, head).text;

// `against` is the BASE side of a compare. A fixture the base lacks is a NEW
// fixture, not an error — anything else wrong with `against` is.
function resolveBase(fixture, against) {
  if (!against) return { hasFixture: false };
  const base = validateDesignTarget({ fixture, module: against });
  if (!base.error) return { hasFixture: true };
  const t = designRenderTarget({ fixture, module: against });
  const onlyFixtureMissing = path.isAbsolute(against)
    && existsSync(path.join(t.moduleDir, "module.json")) && existsSync(t.fixturesDir) && !existsSync(t.fixtureFile);
  return onlyFixtureMissing ? { hasFixture: false } : { error: `against: ${base.error}` };
}

export async function renderFixtureReport({ fixture, module, against, state, theme, width }) {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const head = validateDesignTarget({ fixture, module });
  if (head.error) return text(head.error);

  const base = resolveBase(fixture, against);
  if (base.error) return text(base.error);
  const baseHasFixture = base.hasFixture;

  const themes = theme === "both" ? ["dark", "light"] : [theme ?? "dark"];
  const parts = [];
  const notes = [];
  let images = 0;
  const show = (label, r) => {
    if (r.png) { parts.push({ type: "text", text: label }, { type: "image", data: r.png.toString("base64"), mimeType: "image/png" }); images++; }
    notes.push(`${label} ${r.error ?? r.check}`);
  };
  for (const t of themes) {
    const headRun = await renderFixtureOnce({ fixture, module, theme: t, width, state });
    if (!against) { show(`[${t}]`, headRun); continue; }
    if (!baseHasFixture) {
      notes.push(`[${t}] base: \`${fixture}\` does not exist in ${path.resolve(against)} — new in head.`);
      show(`[${t}] head`, headRun);
      continue;
    }
    const baseRun = await renderFixtureOnce({ fixture, module: against, theme: t, width, state });
    show(`[${t}] base`, baseRun);
    show(`[${t}] head`, headRun);
    const verdict = compareRuns(baseRun, headRun);
    if (verdict.highlight) {
      parts.push({ type: "text", text: `[${t}] diff — changed pixels red, their bounding box yellow, head render dimmed` },
        { type: "image", data: verdict.highlight.toString("base64"), mimeType: "image/png" });
      images++;
    }
    notes.push(`[${t}] ${verdict.text}`);
  }
  const summary = against
    ? `Compared \`${fixture}\`: base ${path.resolve(against)} vs head ${head.moduleDir}`
    : `Rendered \`${fixture}\` from ${head.moduleDir}`;
  return { content: [...parts, { type: "text", text:
    `${summary} (${themes.join("+")})${width ? ` at ${width}px` : ""} — ${images} image(s).\n${notes.join("\n")}` }] };
}

const MAX_VARIANTS = 8;

// Several fixtures in one call: every variant rendered (and compared, with
// `against`), the head renders and diffs returned to the model, and the whole
// set — base, head, diff, checks — written as one self-contained HTML page.
export async function renderGalleryReport({ fixtures, module, against, state, theme, width }) {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const names = [...new Set(fixtures)];
  if (names.length > MAX_VARIANTS) return text(`Error: at most ${MAX_VARIANTS} variants per call (got ${names.length}).`);

  // Validate every variant up front so a typo in the fifth does not cost four renders.
  let moduleDir;
  const bases = new Map();
  for (const fixture of names) {
    const head = validateDesignTarget({ fixture, module });
    if (head.error) return text(`${fixture}: ${head.error}`);
    moduleDir = head.moduleDir;
    const base = resolveBase(fixture, against);
    if (base.error) return text(`${fixture}: ${base.error}`);
    bases.set(fixture, base.hasFixture);
  }

  const themes = theme === "both" ? ["dark", "light"] : [theme ?? "dark"];
  const entries = [];
  const content = [];
  const lines = [];
  for (const fixture of names) {
    const entry = { fixture, newInHead: !!against && !bases.get(fixture), themes: [] };
    for (const t of themes) {
      const head = await renderFixtureOnce({ fixture, module, theme: t, width, state });
      const row = { theme: t, head };
      if (against && bases.get(fixture)) {
        row.base = await renderFixtureOnce({ fixture, module: against, theme: t, width, state });
        row.verdict = compareRuns(row.base, head);
      }
      // The verdict above used the full renders; crop only what is shown. The harness page is
      // 1080px wide and the window a fraction of it, so uncropped galleries are mostly empty.
      const [cHead, cBase, cDiff] = cropToContent([head.png, row.base?.png ?? null, row.verdict?.highlight ?? null], { measure: [0, 1] });
      row.head = { ...head, png: cHead };
      if (row.base) row.base = { ...row.base, png: cBase };
      if (row.verdict?.highlight) row.verdict = { ...row.verdict, highlight: cDiff };
      entry.themes.push(row);
      if (row.head.png) content.push({ type: "text", text: `[${fixture} ${t}]` }, { type: "image", data: row.head.png.toString("base64"), mimeType: "image/png" });
      if (row.verdict?.highlight) {
        content.push({ type: "text", text: `[${fixture} ${t}] diff — changed pixels red, box yellow` },
          { type: "image", data: row.verdict.highlight.toString("base64"), mimeType: "image/png" });
      }
      const vs = row.verdict ? ` | ${row.verdict.text.split("; ")[0]}` : entry.newInHead ? " | new in head" : "";
      lines.push(`${fixture} [${t}]: ${checkSummary(head)}${vs}`);
    }
    entries.push(entry);
  }

  const title = `${path.basename(moduleDir)}: ${names.join(", ")}`;
  const file = writeGallery(buildGalleryHtml({ title, moduleDir, againstDir: against && path.resolve(against), width, entries }),
    `${path.basename(moduleDir)}-${names.length}-variants`);
  content.push({ type: "text", text:
    `Rendered ${names.length} variant(s) from ${moduleDir}${against ? `, compared against ${path.resolve(against)}` : ""} (${themes.join("+")})`
    + `${width ? ` at ${width}px` : ""}.\n${lines.join("\n")}\n`
    + `Gallery (base, head, diff and checks for every variant, self-contained): ${file}` });
  return { content };
}

export function registerServerLocalTools(mcp) {
  registerRawTool(mcp, "list_connected_bridges",
    "List all Foundry users currently connected via the bridge module. "
    + "Use `userName` (or `userName@host` to disambiguate when the same "
    + "name is connected from two worlds) as the `targetUser` parameter "
    + "on other tools to route calls. `userId` also works as an "
    + "unambiguous escape hatch. The GM is the default target.",
    {},
    async () => {
      const list = [...bridges.values()]
        .filter(b => b.userId !== "__legacy__")
        .map(b => ({
          userId:      b.userId,
          userName:    b.userName,
          host:        b.host || "",
          isGM:        b.isGM,
          connectedAt: new Date(b.connectedAt).toISOString(),
        }))
        .sort((a, b) => {
          if (a.isGM !== b.isGM) return a.isGM ? -1 : 1;
          return a.userName.localeCompare(b.userName);
        });

      // Surface the targetable string per bridge: the bare userName if it
      // is unique across connected bridges, otherwise "userName@host".
      const nameCounts = new Map();
      for (const b of list) nameCounts.set(b.userName, (nameCounts.get(b.userName) ?? 0) + 1);
      for (const b of list) {
        b.targetUser = (nameCounts.get(b.userName) > 1 && b.host)
          ? `${b.userName}@${b.host}`
          : b.userName;
      }

      const result = { bridges: list };

      // Relayed clients are reached through Foundry rather than a direct
      // socket, so they never appear in `bridges` — but they are exactly as
      // targetable, and for a remote device they are the ONLY way to target
      // it. Listing them separately keeps the distinction visible (a relayed
      // client depends on the gateway being up) without hiding them.
      try {
        const relayed = await relayClients();
        if (relayed.length) {
          result.relayedClients = relayed
            .map((c) => ({
              clientId:     c.clientId,
              label:        c.label,
              userName:     c.userName,
              isGM:         c.isGM,
              capabilities: c.capabilities,
              lastSeenMsAgo: c.ageMs,
              // clientId is always unambiguous; a shared userName is not,
              // which is the collision the direct registry gets wrong.
              targetUser:   c.clientId,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
          result.relayNote = "Relayed clients are reached through Foundry's own socket via the "
            + "gateway browser. Address them by `clientId` or device label — a shared `userName` "
            + "is ambiguous when one person is signed in on two devices.";
        }
      } catch { /* gateway down or mid-restart; direct bridges still listed */ }

      if (bridges.has("__legacy__")) {
        result.legacyBridgeConnected = true;
        result.note = "A pre-multi-user bridge is connected and is being treated as the default GM. "
          + "Update the foundry-mcp-live module so it identifies itself for direct addressing.";
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

  registerRawTool(mcp, "bridge_status",
    "Diagnose the MCP-to-Foundry connection without requiring a live bridge. "
    + "Reports connected and last-seen bridges, probes known Foundry /api/status "
    + "endpoints, and classifies the state as bridge-connected, "
    + "foundry-up-no-bridge, foundry-up-no-users, foundry-down, or unknown.",
    {},
    async () => {
      const result = await getBridgeDiagnosis();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

  if (RELAUNCH_CONFIG.enabled) {
    registerRawTool(mcp, "relaunch_client",
      "Launch the explicitly configured Chrome executable, join the configured "
      + "Foundry world as the configured GM, and wait for its MCP bridge. "
      + "This server-local recovery tool is absent unless "
      + "FOUNDRY_RELAUNCH_ENABLED=1. Credentials are read only from the server "
      + "environment and are never accepted as tool parameters or returned.",
      {
        timeoutMs: z.number().min(5_000).max(120_000).optional().describe(
          "Total ms to allow for Chrome launch, Foundry join, and bridge registration. "
          + "Default 30000."
        ),
      },
      async params => {
        const result = await relaunchClient(params);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      });
  }

  registerRawTool(mcp, "reload_foundry",
    "Reload a Foundry tab and wait until it has reconnected its bridge AND "
    + "`game.ready` is true. Use after editing module code that needs to be "
    + "re-read by the browser. Targets the GM by default; pass `targetUser` "
    + "for a specific player tab. Saves the manual reload + sleep + poll "
    + "dance and avoids the 'Server not initialized' race that happens when "
    + "you call MCP tools too soon after a raw `evaluate(window.location.reload())`.\n\n"
    + "Set `hardReload: true` to clear the browser's Cache API and unregister "
    + "service workers before reloading — use this after editing bridge/module "
    + "code to guarantee Foundry picks up the new JS/CSS instead of serving stale "
    + "cached files. Default (false) does a cache-busting location.replace() which "
    + "busts the HTML cache but not module/service-worker caches.",
    {
      targetUser: z.string().optional().describe(
        'Foundry user whose tab to reload. Omit (or pass "GM" / "self") to '
        + 'target the GM (default). Pass a player\'s exact user name to reload '
        + 'their tab. Use list_connected_bridges to see who is currently connected.'
      ),
      hardReload: z.boolean().optional().describe(
        "Clear Cache API caches and unregister service workers before reloading. "
        + "Default false. Set true after editing bridge/module JS to bypass "
        + "Foundry's service-worker and module cache."
      ),
      timeoutMs: z.number().optional().describe(
        "Total ms to wait for reconnect AND game.ready. Default 30000 (30s). "
        + "Hard reloads may need extra time for cache revalidation — bump to "
        + "60000 if service worker re-registration is slow."
      ),
    },
    async ({ targetUser, hardReload = false, timeoutMs = 30_000 }) => {
      let bridge;
      try { bridge = routeBridge(targetUser); }
      catch (err) {
        return diagnosisReply(err.message, await getBridgeDiagnosis());
      }

      // Refuse to reload through the legacy fallback bucket — it can't
      // satisfy our hello-waiter (legacy bridges never send hello), so the
      // wait would always time out at 30s. Tell the user how to proceed.
      if (bridge.userId === "__legacy__") {
        return { content: [{ type: "text", text:
          "Error: reload_foundry requires a multi-user-aware bridge "
          + "(foundry-mcp-live v0.2.0+). The targeted bridge appears to "
          + "be a legacy install. Upgrade the bridge module, or run "
          + "`evaluate({expression: \"window.location.reload()\"})` manually "
          + "and reconnect Claude Code on your own."
        }] };
      }

      const targetUserId   = bridge.userId;
      const targetUserName = bridge.userName;
      const reloadStartedAt = Date.now();

      // Issue a reload via evaluate. Two modes:
      //   soft (default): cache-busting query-param on location.replace() —
      //     bypasses the HTML cache but NOT the service-worker / module cache.
      //   hard (hardReload=true): clears all Cache API caches, unregisters
      //     service workers for this origin, then forces a hard reload.
      // The setTimeout(50) gives the eval a chance to return before the
      // browser navigates away. Reply may never arrive (socket closes
      // mid-handler) — that's expected, so we ignore failures here and
      // proceed straight to the wait.
      const reloadExpr = hardReload
        ? "setTimeout(async () => { "
        +   "try { "
        +     "const keys = await caches.keys(); "
        +     "await Promise.all(keys.map(k => caches.delete(k))); "
        +   "} catch(e) {} "
        +   "try { "
        +     "const regs = await navigator.serviceWorker?.getRegistrations?.(); "
        +     "if (regs) await Promise.all(regs.map(r => r.unregister())); "
        +   "} catch(e) {} "
        +   "window.location.reload(); "
        + "}, 50); "
        + "'cache cleared + reloading'"
        : "setTimeout(() => { "
        +   "const u = new URL(window.location.href); "
        +   "u.searchParams.set('_mcpReload', Date.now()); "
        +   "window.location.replace(u.toString()); "
        + "}, 50); "
        + "'reloading'";
      try {
        await requestFoundry("evaluate", {
          expression: reloadExpr,
        }, targetUserId);
      } catch { /* expected — socket closes during reload */ }

      // Wait for the new bridge with the same userId to announce via hello.
      const helloDeadlineMs = Math.max(1000, timeoutMs - (Date.now() - reloadStartedAt));
      let newBridge;
      try {
        newBridge = await new Promise((resolve, reject) => {
          // Replace any prior waiter for this user — last one wins.
          const prev = reconnectWaiters.get(targetUserId);
          if (prev) {
            clearTimeout(prev.timer);
            prev.reject(new Error("Superseded by a newer reload_foundry call"));
          }
          const timer = setTimeout(() => {
            reconnectWaiters.delete(targetUserId);
            reject(new Error(
              `Timeout waiting for ${targetUserName} to reconnect after reload (${helloDeadlineMs}ms)`
            ));
          }, helloDeadlineMs);
          reconnectWaiters.set(targetUserId, { resolve, reject, timer });
        });
      } catch (err) {
        return diagnosisReply(err.message, await getBridgeDiagnosis());
      }
      const reconnectedAt = Date.now();

      // Poll game.ready with a short interval until the remaining timeout.
      // Bridge returns `{ result, evalMs }` — read `.result`.
      const readyDeadline = reloadStartedAt + timeoutMs;
      let gameReadyAt = null;
      while (Date.now() < readyDeadline) {
        try {
          const reply = await requestFoundry("evaluate", {
            expression: "return game?.ready === true;",
          }, targetUserId);
          if (reply?.result === true) { gameReadyAt = Date.now(); break; }
        } catch { /* not ready yet, keep polling */ }
        await new Promise(r => setTimeout(r, 200));
      }

      if (!gameReadyAt) {
        return { content: [{ type: "text", text: JSON.stringify({
          ready: false,
          targetUser: targetUserName,
          reloadStartedAt: new Date(reloadStartedAt).toISOString(),
          reconnectedAt:   new Date(reconnectedAt).toISOString(),
          note: "Bridge reconnected but game.ready never became true within timeoutMs",
        }, null, 2) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({
        ready: true,
        targetUser:        targetUserName,
        reloadStartedAt:   new Date(reloadStartedAt).toISOString(),
        reconnectedAt:     new Date(reconnectedAt).toISOString(),
        gameReadyAt:       new Date(gameReadyAt).toISOString(),
        totalDurationMs:   gameReadyAt - reloadStartedAt,
        helloLatencyMs:    reconnectedAt - reloadStartedAt,
        readyLatencyMs:    gameReadyAt - reconnectedAt,
      }, null, 2) }] };
    });

  if (designHarnessReady()) {
    registerRawTool(mcp, "render_fixture",
      "Render a design-harness fixture to a PNG in a Foundry v14 window frame with no world "
      + "running (core CSS + the game system's CSS + a module's stylesheets, offline) and return "
      + "the image plus the harness's layout check (visible/primary button counts, overflow, tiny "
      + "controls, missing string keys). The offline design-review loop for any module checkout — `screenshot` is its "
      + "live-world counterpart; theme 'both' renders dark and light in one call; `against` compares a base checkout with the head and reports whether pixels and the layout check changed (PR review). `fixtures` renders several variants at once and writes one HTML gallery of them. Present only when a design harness is installed on this host "
      + "(FOUNDRY_DESIGN_HARNESS overrides the default path); needs chromium on the host.",
      {
        fixture: z.string().regex(/^[\w-]+$/).optional().describe(
          "Fixture name — a file in the module's tools/design-harness/fixtures/, without .mjs. "
          + "Omit to list the available fixtures (and other modules that have a harness)."
        ),
        module: z.string().optional().describe(
          "Absolute path to the module checkout to render (any Foundry module). "
          + "Default: the harness's own module."
        ),
        fixtures: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(8).optional().describe(
          "Several fixtures in one call (use instead of `fixture`) — e.g. a window's variants. Returns each head render "
          + "(and diff, with `against`) plus a one-line summary per variant, and writes ONE self-contained HTML gallery "
          + "of base/head/diff/checks for all of them; the reply gives its path."
        ),
        state: z.string().regex(/^[\w.-]+$/).optional().describe(
          "Named fixture state, when the fixture defines them (see its build(state))."
        ),
        against: z.string().optional().describe(
          "Absolute path to a BASE module checkout (a PR's base worktree, a release checkout). Renders the "
          + "fixture from both — `against` is the base, `module` (or the default module) is the head — and reports "
          + "whether the pixels and the layout check changed. A fixture missing from the base is reported as new."
        ),
        theme: z.enum(["dark", "light", "both"]).optional().describe("Window theme: 'dark' (default), 'light', or 'both' (renders twice and returns both images — light is where most design misses happen)."),
        width: z.number().int().positive().optional().describe(
          "Force the window width in px (e.g. 420 to check the narrow case)."
        ),
      },
      async (p) => {
        if (p.fixtures && p.fixture) return { content: [{ type: "text", text: "Error: pass `fixture` or `fixtures`, not both." }] };
        return p.fixtures ? renderGalleryReport(p) : renderFixtureReport(p);
      });

    registerRawTool(mcp, "write_variant",
      "Author a design VARIANT of an existing harness fixture, then look at it with render_fixture {fixtures:[base, name]}. "
      + "A variant swaps handlebars templates and/or appends CSS (plus optional title/width/classes) — you supply data, never code: "
      + "the fixture's JavaScript is generated by the tool, and it only writes under <module>/tools/design-harness/ "
      + "(fixtures/<name>.mjs and variants/<name>/*.hbs), never over a hand-written fixture. "
      + "action 'write' (default) creates or updates a variant; action 'discard' deletes a variant this tool generated. "
      + "The files are real files in the module checkout (visible to git) — discard the ones you do not keep. "
      + "Present only when a design harness is installed on this host.",
      {
        action: z.enum(["write", "discard"]).optional().describe("'write' (default) or 'discard'."),
        name: z.string().regex(/^[A-Za-z0-9][\w-]*$/).describe("The variant's fixture name (new, or a variant this tool generated)."),
        base: z.string().regex(/^[A-Za-z0-9][\w-]*$/).optional().describe("Existing fixture to derive from. Required for write."),
        module: z.string().optional().describe("Absolute path to the module checkout. Default: the harness's own module."),
        templates: z.record(z.string(), z.string()).optional().describe(
          "Template swaps: key = the template path the base fixture uses (e.g. 'templates/crawl-tracker-list.hbs'), "
          + "value = the new handlebars source. Use the same context shape and data-action names as the real template. "
          + "The reply lists the template paths the base fixture mentions."
        ),
        css: z.string().optional().describe("CSS appended to the window's styles (after the base fixture's)."),
        title: z.string().optional().describe("Override the window title."),
        width: z.number().int().positive().optional().describe("Override the window width in px."),
        classes: z.array(z.string().regex(/^[\w-]+$/)).optional().describe("Override the window's CSS classes."),
      },
      async ({ action = "write", name, base, module, templates, css, title, width, classes }) => {
        const text = (t) => ({ content: [{ type: "text", text: t }] });
        if (action === "write" && !base) return text("Error: `base` (the fixture to derive from) is required for write.");
        const target = validateDesignTarget({ fixture: action === "write" ? base : name, module });
        if (target.error) return text(target.error);
        const rel = (f) => path.relative(target.moduleDir, f);
        if (action === "discard") {
          const r = discardVariant(target.moduleDir, name);
          return text(r.error ? `Error: ${r.error}` : `Discarded variant \`${name}\`: removed ${r.removed.map(rel).join(", ")}.`);
        }
        const r = writeVariant(target.moduleDir, { name, base, templates, css, title, width, classes });
        if (r.error) return text(`Error: ${r.error}`);
        const warn = r.unmatched.length
          ? `\nWarning: ${r.unmatched.map((k) => `\`${k}\``).join(", ")} not found in \`${base}\` — it will have no effect. `
            + (r.known.length ? `Templates \`${base}\` mentions: ${r.known.join(", ")}.` : `\`${base}\` mentions no .hbs templates (a JS-built window cannot swap templates; use css).`)
          : "";
        return text(`Wrote variant \`${name}\` of \`${base}\` in ${target.moduleDir}: ${[r.fixtureFile, ...r.templateFiles].map(rel).join(", ")}.${warn}\n`
          + `Next: render_fixture {fixtures: ["${base}", "${name}"], theme: "both"} to compare; write_variant {action: "discard", name: "${name}"} to remove it.`);
      });
  }

  // preview_fixture hands the window to the module's design_preview handler as data, so it needs
  // neither the eval gate nor a direct bridge (the relay carries it).
  if (designHarnessReady()) {
    registerRawTool(mcp, "preview_fixture",
      "Open a design-harness fixture as a REAL window inside a live Foundry client: the same compiled "
      + "markup and CSS the harness renders offline, but shown in the actual session so the real cascade, "
      + "fonts and theme apply (the harness can disagree with the live client on layered-vs-re-injected "
      + "stylesheet conflicts). Renders the fixture's parts plus its own css — proposal fixtures bring "
      + "their kit — opens (or replaces) one preview window, screenshots it back (CDP real pixels when a Chrome debugger port answers, html2canvas fallback — flagged in the reply — otherwise), and LEAVES IT OPEN for "
      + "inspection; close it with `close: true` or its ✕. Nothing is persisted and no world documents "
      + "change. Present only when a design harness is installed on this host "
      + "(FOUNDRY_DESIGN_HARNESS overrides the default path).",
      {
        fixture: z.string().regex(/^[\w-]+$/).optional().describe(
          "Fixture name — a file in the module's tools/design-harness/fixtures/, without .mjs. Required unless close:true (omit to list the available ones)."
        ),
        module: z.string().optional().describe(
          "Absolute path to the module checkout to render (any Foundry module). Default: the harness's own module."
        ),
        state: z.string().regex(/^[\w.-]+$/).optional().describe(
          "Named fixture state, when the fixture defines them (see its build(state))."
        ),
        width: z.number().int().positive().optional().describe(
          "Override the window width in px; default: the fixture's own width (else 600)."
        ),
        close: z.boolean().optional().describe(
          "Close the preview window in the target client and return instead of opening a new one."
        ),
        targetUser: z.string().optional().describe(TARGET_USER_DESC),
      },
      async ({ fixture, module, state, width, close, targetUser }) => {
        let bridge;
        try { bridge = routeBridge(targetUser); }
        catch (err) { return diagnosisReply(err.message, await getBridgeDiagnosis()); }
        const targetUserId = bridge.userId;

        if (close) {
          try {
            const result = await callPreview({ close: true }, buildPreviewCloseExpression, targetUserId);
            return { content: [{ type: "text", text: result?.closed
              ? `Preview window closed on ${bridge.userName}.`
              : `No preview window was open on ${bridge.userName}.` }] };
          } catch (err) {
            return diagnosisReply(`closing the preview failed: ${err.message}`, await getBridgeDiagnosis());
          }
        }

        const target = validateDesignTarget({ fixture, module });
        if (target.error) return { content: [{ type: "text", text: target.error }] };

        let fragment;
        try { fragment = await fetchFixtureFragment({ fixture, module, state }); }
        catch (err) { return { content: [{ type: "text", text: `preview_fixture: ${err.message}` }] }; }

        const widthPx = width ?? (Number.isFinite(Number(fragment.width)) ? Number(fragment.width) : 600);
        let openResult;
        try {
          const open = { html: fragment.html, css: fragment.css, title: fragment.title, classes: fragment.classes, width: widthPx };
          openResult = await callPreview(open, () => buildPreviewOpenExpression(open), targetUserId);
        } catch (err) {
          return diagnosisReply(`opening the preview failed: ${err.message}`, await getBridgeDiagnosis());
        }
        if (openResult?.opened !== true) {
          return { content: [{ type: "text", text:
            `preview_fixture: the client refused the preview — ${JSON.stringify(openResult).slice(0, 400)}` }] };
        }

        const missingNote = Array.isArray(fragment.missing) && fragment.missing.length
          ? `\nmissing strings: ${fragment.missing.join(", ")}` : "";
        try {
          // Real pixels via CDP first: html2canvas re-renders text off its
          // baseline (initiative numbers and button labels read low in its
          // output), which misleads a design read. Fall back to it only when
          // no debugger port answers (or none is logged in as the routed bridge's
          // user), and say which was used.
          let shot = null;
          let exact = false;
          let cdpWhy = "";
          try {
            const cdp = await cdpScreenshot(`#${PREVIEW_WINDOW_ID}`, { scale: 2, format: "png", userId: targetUserId });
            if (cdp && !cdp.error) { shot = { image: cdp.image, mimeType: cdp.mimeType }; exact = true; }
            else cdpWhy = cdp?.error ?? "";
          } catch (err) { cdpWhy = err.message; /* no usable debugger page — fall through to html2canvas */ }
          if (!shot) {
            shot = await requestFoundry("screenshot_dom",
              { selector: `#${PREVIEW_WINDOW_ID}`, scale: 1, format: "png" }, targetUserId);
          }
          if (shot?.image) {
            return { content: [
              { type: "image", data: shot.image, mimeType: shot.mimeType ?? "image/png" },
              { type: "text", text:
                `Previewed \`${fixture}\` on ${bridge.userName} — live Foundry cascade (client's own theme), `
                + (exact ? "CDP real pixels" : `html2canvas fallback — text baselines approximate${cdpWhy ? ` (CDP: ${cdpWhy})` : ""}`) + ". "
                + `Window LEFT OPEN (id ${PREVIEW_WINDOW_ID}); close it with preview_fixture {close:true} or its ✕.`
                + missingNote },
            ] };
          }
          return { content: [{ type: "text", text:
            `Previewed \`${fixture}\` on ${bridge.userName} — window LEFT OPEN, but the screenshot failed: ${JSON.stringify(shot).slice(0, 300)}` + missingNote }] };
        } catch (err) {
          return { content: [{ type: "text", text:
            `Previewed \`${fixture}\` on ${bridge.userName} — window LEFT OPEN, but the screenshot failed: ${err.message}` + missingNote }] };
        }
      });
  }
}
