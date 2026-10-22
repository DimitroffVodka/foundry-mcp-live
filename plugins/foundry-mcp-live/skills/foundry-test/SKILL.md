---
name: foundry-test
description: >-
  Use when designing, adding, running, or debugging automated tests for a Foundry VTT module or
  system — unit tests, integration tests, live verification, or end-to-end browser tests. Trigger
  this whenever someone wants to set up a test harness, write a regression test for a Foundry bug,
  run or fix Quench tests, verify behavior in a live world, add Playwright coverage for
  login/canvas/tab-visibility issues, or simply decide *which kind* of test a given Foundry behavior
  needs. Use it even when the user names only a symptom ("the map is blank when the tab is in the
  background", "my setting isn't saving") rather than the word "test" — the first job of this skill
  is choosing the cheapest layer that can actually catch the failure.
version: 1.0.0
license: MIT
metadata:
  tags: [foundryvtt, testing, quench, playwright, node-test, mcp]
---

# Foundry VTT Module Testing

## The core idea: test at the cheapest layer that can observe the failure

Foundry testing has four layers. They are not interchangeable, and the reason is not just speed —
**each layer can observe and control things the cheaper one cannot.** Picking the layer is the same
question as asking *"what does the bug need in order to reproduce?"*

| Layer | What it can reach | What it CANNOT reach |
|---|---|---|
| **1. `node:test`** | pure JS — parsers, math, data transforms | anything that reads `game`/`foundry`/`canvas`/`ui` |
| **2. Quench** (Mocha in-client) | the *foreground* live client — documents, hooks, settings, data models, canvas state | login, tab visibility, headless/headed differences, session lifecycle |
| **3. MCP live bridge** | the *current* running world, ad hoc, from outside | nothing reusable — it's a probe, not a suite |
| **4. Playwright** | the *browser itself* — login, storage, focus/blur, tab backgrounding, headless vs headed | cheap iteration; it's the slowest and most fragile, so it must earn its place |

Layers 1–3 all run *inside* an already-logged-in, foreground client. The moment a bug depends on the
browser *getting* to that state, or on the page not being in front, only Layer 4 can see it. That
single fact decides most layer choices.

**Rule of thumb:** if the code touches `game`, `foundry`, `canvas`, `ui`, hooks, or documents, test it
in a real client (Quench, or MCP for a one-off check). Otherwise unit-test it with `node:test`. Reach
for Playwright only when the *browser workflow* — login, session, storage, visibility, headed/headless
— is itself the thing under test.

## Decision table

| Testing target | Layer | Why |
|---|---|---|
| Pure function, no Foundry globals | `node:test` | milliseconds, CI-friendly, no client needed |
| Parser / converter / grid or coordinate math | `node:test` **fixture test** | capture real output once, freeze it, assert forever |
| Invariant about a vendored/shipped file | `node:test` **contract test** | catches upstream drift without a client |
| Compendium pack content (names, formulas, counts) drifting | `node:test` on **CLI-unpacked** packs | unpack the LevelDB to JSON once, assert metadata — no client (feeds Layer 1) |
| Settings, hooks, data models, documents | Quench | needs real Foundry runtime APIs |
| Scene / token / canvas / region content | Quench + MCP read-back | reusable assertions + live structured inspection |
| "Did this actually work just now?" | MCP live | fastest probe of the real world |
| Hook / socket-sync / workflow *misfire* in a live world | MCP `trace` (actions `hooks` / `socket` / `workflow`) | watch what actually fires, vs. guessing behavior from source |
| Login, session contention, storage, downloads | Playwright | only browser automation reaches these |
| Backgrounded-tab / `requestAnimationFrame` / repaint bug | Playwright **headed** | the failure only exists when the page isn't in front |
| One-off interactive browser drive (multi-context GM/player, reconnect) | **Playwright MCP** | agentic driver; promote to `@playwright/test` only when you need a reusable regression |
| GM-vs-player visibility/permission difference | MCP `targetUser`, or Playwright MCP / player login | inspect each client separately |

## When you start: inventory before you write

1. **Read the repo first.** `git status`; then `package.json`, `module.json` (id + `compatibility`),
   `test/`, the module entry point, any `quenchReady` hook, Playwright config, and CI config. Match
   the patterns already there instead of importing a new framework.
2. **Discover the live environment — never hardcode it.** Paths, world name, system, and usernames
   change per machine. Read them at runtime: MCP `get_game_info` / `get_debug_snapshot` /
   `list_connected_bridges`, and the repo's `module.json`.
3. **Add the narrowest test that catches the bug.** Walk *up* the layers — only climb when the layer
   below genuinely can't observe the failure. A bug reproduced as a `node:test` is worth ten manual
   client checks.
4. **Verify for real, then clean up.** Run the actual command or live check, read recent console
   errors, and delete any world data the test created.

## Reference files — load on demand

Keep these out of the always-loaded body; read them when you reach that layer:

- `references/playwright-foundry-e2e.md` — **read before writing any Playwright test.** Auth via
  saved `storageState`, the mechanics of deterministically backgrounding a tab, waiting on Foundry's
  own readiness signals instead of timeouts, trace/video artifacts, CI realities; plus **Playwright MCP**
  (`@playwright/mcp`) as the *interactive* driver — multi-context GM/player, login/reconnect,
  canvas-blindness — vs. `@playwright/test` for reusable regressions.
- `references/content-fixtures-via-cli.md` — using the official Foundry CLI (`@foundryvtt/foundryvtt-cli`)
  to `unpack` binary compendium packs into JSON so Layer 1's fixture/contract patterns apply to
  *content*: the locked-LevelDB / `--in` vs `-n` gotchas, keeping fixtures metadata-only, and
  `fvtt launch --world` as server/world-level recovery.
- `references/quench-v14-troubleshooting.md` — Quench-on-v14 symptoms (wedged runner, result-window
  errors, snapshot risk) as a symptom→action table.
- `references/mcp-live-verification.md` — bridge preflight, tool-name spellings across clients,
  hidden-tab/main-thread gotchas, `evaluate` payload discipline, live cleanup; the **live debugging
  family** (`trace` (actions `hooks` / `socket` / `workflow`), `snapshot` (take/diff),
  `interact` dialog); plus surviving a client crash (dedicated supervised client + headless
  software-WebGL CPU trap), v14 `evaluate` introspection gotchas (`Hooks.events` non-enumerable,
  plain-DOM UI), and v14 movement segmentation.

---

## Layer 1 — `node:test`: units, fixtures, contracts

Node's built-in runner is the default for anything pure. No dependency, runs in milliseconds, happy
in CI. The whole game here is **keeping logic pure enough to import under Node.**

### The purity rule (this is what breaks people)

A module imported under Node must not touch `game`, `foundry`, `CONST`, `canvas`, or `ui` *at the top
level* — those globals don't exist outside a browser, so the `import` itself throws before a single
assertion runs. Access them lazily inside functions, or keep that code out of your pure modules.

```js
// ✗ throws the moment Node imports this file
const MODULE = game.modules.get("my-module");

// ✓ resolved only when called, inside a real client
export function getModule() {
  return globalThis.game?.modules?.get("my-module");
}
```

The practical move: put parser/math/adapter logic in side-effect-free modules (e.g. `scripts/lib/`)
and keep Foundry-coupled entry files thin. Pure logic that lives behind a clean boundary is the
single biggest lever on how much of your module is testable at all.

### Commands

```sh
node --test test/*.test.mjs      # scoped on purpose
node --check scripts/<file>.mjs  # fast syntax gate after edits
```

Avoid bare `node --test` in a repo that has `test/quench/` or `test/e2e/` — it recurses into those
and tries to import Quench/Playwright, which fail outside their runtimes. Scope the glob.

### Three durable patterns

- **Unit** — the pure function directly (grid math, coordinate conversion, normalization).
- **Fixture** — capture one real output from the live system, commit it under `test/fixtures/`, and
  assert your converter still produces the known-good result. This is how you regression-test a
  parser without a running client: the fixture *is* the frozen real-world input.
- **Contract** — assert a vendored/shipped file still contains the anchor string or key your runtime
  depends on. If your code patches a third-party bundle by injecting at an anchor, a contract test
  fails loudly when an upstream rebuild moves that anchor, instead of the feature silently degrading.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// contract: the patch target still exists in the shipped bundle
const bundle = readFileSync(new URL("../vendor/app.js", import.meta.url), "utf8");
test("vendored bundle still exposes its patch anchor", () => {
  assert.ok(bundle.includes("__expectedPatchGlobal"), "anchor moved — runtime patch will silently fail");
});
```

### Compendium content is testable too — unpack it with the Foundry CLI

The fixture and contract patterns aren't limited to code. The official Foundry CLI
(`@foundryvtt/foundryvtt-cli`, the `fvtt` binary) **`unpack`s** a module's binary LevelDB compendium
packs into per-entry JSON/YAML — turning shipped *content* (spells, monsters, roll tables) into plain
files you can freeze as fixtures and guard with contract tests, no running client required. This is a
**Layer-1 input technique, not a fifth layer**: once unpacked, the assertions are ordinary `node:test`.

Two traps, with the rest in `references/content-fixtures-via-cli.md`: a running world holds a **lock**
on its pack LevelDB — copy the pack dir and unpack the *copy*; and `--in` is the **parent** dir while
`-n` names the pack subdir (JSON by default, `--yaml` for YAML). Keep fixtures small by asserting
metadata (names, structure, formulas, ranges) rather than vendoring full description prose.

---

## Layer 2 — Quench: in-client integration

Quench runs Mocha/Chai *inside* a real Foundry client, so it's the right home for anything that needs
documents, hooks, settings, data models, or canvas state. Two things separate a good Quench batch
from a flaky one: **dev-gating** and **crash-safe cleanup.**

### Register only when Quench is present

Importing test batches for normal users is wasted load and a support risk. Gate registration on the
`quenchReady` hook and lazy-import the batch, so it never enters a non-dev session:

```js
Hooks.on("quenchReady", async (quench) => {
  const { registerMyBatches } = await import("../test/quench/my.batch.mjs");
  registerMyBatches(quench);
});
```

Batch keys start with the package id (`my-module.import`) so they're easy to target and namespace.

### Clean up at both ends, not just after

`afterEach` deletes what a passing test made — but a test that *throws* before teardown, or a run
that wedges, leaks documents into the world that accumulate across runs. Add a `before` sweep that
removes leftovers from a previous crashed run, scoped to a module-specific name prefix so it can
never touch real data:

```js
export function registerMyBatches(quench) {
  quench.registerBatch("my-module.feature", (context) => {
    const { describe, it, assert, before, afterEach } = context;
    const created = [];

    before(async function () {
      // self-heal after a crashed prior run
      const stale = game.scenes.filter(s => s.name.startsWith("Test my-module ")).map(s => s.id);
      if (stale.length) await Scene.deleteDocuments(stale);
    });

    afterEach(async function () {
      if (created.length) await Scene.deleteDocuments(created.splice(0));
    });

    describe("feature", function () {
      it("does X in a real client", async function () {
        this.timeout(60000);                                   // needs a function, not an arrow
        const scene = await Scene.create({ name: `Test my-module ${Date.now()}` });
        created.push(scene.id);
        assert.exists(scene.id);
      });
    });
  }, { displayName: "My Module: feature" });
}
```

Other rules that save time: use `function () {}` (not arrows) wherever you call `this.timeout(ms)`;
restore any setting or active scene you change; don't depend on pre-existing world data unless the
module ships it. For v14-specific Quench failures (wedged runner, result-window errors, snapshot
incompatibility), read `references/quench-v14-troubleshooting.md`.

---

## Layer 3 — MCP live verification

The MCP bridge drives the *currently running* world from outside the client. It's the fastest way to
answer "did this actually work?" and to debug live state — but it's a **probe, not a test suite.** Use
it to verify a fix before reporting success, then capture the durable version as a Quench or unit
test.

**Preflight before trusting it:** confirm the bridge is actually connected — `bridge_status`, then
`list_connected_bridges` for routable user names. If nothing's connected, start the world, enable the
bridge module, reload the client, and retry. Skipping this turns every later call into a confusing
failure.

**Tool names differ by client.** Refer to tools by their bare logical name (`get_game_info`,
`evaluate`, `reload_foundry`); the surface you're on wraps them (Claude shows
`mcp__foundry-vtt__get_game_info`; other hosts may show `mcp_foundry-vtt_get_game_info`). Select the
tool that's actually present — don't hand-type a third spelling.

The verification loop: capture baseline (`get_debug_snapshot`, `scene_read`, relevant placeables) →
trigger the action → read **structured** state back (not just a screenshot) → read recent console
errors → delete what you created by exact id → report what you actually observed. When you use
`evaluate`, return small plain-JSON projections (`scenes.map(s => ({id, name}))`), not raw documents —
they serialize badly and large payloads get truncated. And the bridge isn't only for reads — if yours
exposes them, `trace` (actions `hooks` / `socket` / `workflow`) trace *behavior* (what fires, syncs, or
runs), which is the live answer to "why isn't this hook firing?" — especially since v14 won't let you
enumerate hooks statically. Details, gotchas, and recipes are in
`references/mcp-live-verification.md`.

> For a module that claims to produce *playable* maps, an image-only scene is not proof. Read back
> walls, doors, and regions (`scene_read` placeables, plus Levels via `evaluate`) — verify the geometry, not
> just that a scene exists.

---

## Layer 4 — Playwright E2E

Playwright is the slowest, most fragile layer, so it should be the smallest — but it's the **only**
layer that can drive the browser *itself*. Use it when the browser workflow is the thing under test:

- `/join` login and session contention
- browser storage / session bugs
- iframe export interception, file downloads/uploads
- **headed-vs-headless differences, focus/blur, and backgrounded-tab / `requestAnimationFrame`
  regressions** — the canonical case where every other layer is blind, because the bug only exists
  when the page isn't in front

### Two Playwright surfaces: the MCP driver vs. a test suite

There are two ways to use Playwright here, answering different questions:

- **Playwright MCP** (`@playwright/mcp`) is the *interactive, agentic* driver — the Layer-4 analogue of
  the MCP live bridge. It drives a real browser through accessibility snapshots, so it reaches what the
  in-client bridge can't: multi-context **GM-vs-player** sessions, the `/join` login/session lifecycle,
  and network-fault / reconnect behavior. It is **canvas-blind** (the WebGL board isn't in the a11y
  tree) — read in-world state with `browser_evaluate`, not snapshots — and the headless software-WebGL
  CPU trap still applies, so pre-seed `core.noCanvas` via an init script.
- **`@playwright/test`** is for the *reusable regression* — the durable, CI/local-lane suite
  (storageState auth, headed backgrounded-tab repaint, traces).

**Run reusable specs with the `ui_test` MCP tool, not against the live world.** foundry-mcp-live
ships a shared harness (`tools/ui-test`: `@playwright/test` + `@thefehr/foundry-playwright`) for any
module. Specs live in the module repo at `e2e/*.spec.mjs` and start with
`import { test, expect } from "@foundry-mcp-live/ui-test";` — each test begins joined as Gamemaster,
with `foundry.state` helpers (`createTestActor`, `grantCurrency`, … via a system adapter: shadowdark,
dnd5e, pf2e). `ui_test {action: "run", module: "<abs path>"}` boots a **throwaway Foundry** (own
dataPath and 127.0.0.1 port 30700–30799, fresh world of the module's system, module enabled), runs
the specs in the background, deletes the sandbox, and `ui_test {action: "status", runId, waitMs: 40000}`
returns pass/fail per test with the failure message and screenshot/trace paths. The module repo
needs no Playwright install; from a shell it is `node <foundry-mcp-live>/tools/ui-test/run.mjs
--module .`. Prove a new spec both ways: green on the real code, red with the behaviour broken.
Details in `references/playwright-foundry-e2e.md` §2.

Same rule as Layer 3→1: drive it interactively with Playwright MCP to answer "does this work right now
across two clients?", then capture the durable version as a `@playwright/test` spec. Both surfaces are
covered in `references/playwright-foundry-e2e.md`.

For a visibility / render-loop bug, the **primary** regression must be a real browser test that
actually backgrounds or hides the page. It's tempting to write a fast `node:test` with a faked
`requestAnimationFrame` and call it done — but that tests your *model* of the bug, not the bug. It
can't observe the real repaint/capture failure, so it can *document* the mechanism but must never
stand in for the browser test.

Three things make or break Playwright-against-Foundry, and they're exactly what naive attempts skip.
**Read `references/playwright-foundry-e2e.md` before writing a test** — it has the working code for
each:

1. **Auth via saved `storageState`, not a login-per-test.** Log in once in a setup project, save the
   session to JSON, and reuse it. This kills the dominant source of flakiness *and* most of the
   "user already connected" contention (Foundry greys out an already-connected user on `/join`).
2. **Determinism: wait on Foundry's own signals, never `waitForTimeout`.** Wait for `game.ready`, a
   specific hook, a DOM selector, or a `window.__test*` flag you set. Arbitrary sleeps are why
   Foundry E2E tests rot.
3. **A backgrounded tab must be created deliberately.** Headless Chromium often does *not* throttle
   `requestAnimationFrame` the way a real backgrounded tab does, so a visibility bug may not
   reproduce headless at all. You typically need headed mode plus a second page brought to the front
   (or a CDP visibility override) to force the original tab into the background — the reference shows
   how. Mark such tests headed-only and skip them in a headless CI lane.

Make the fragility pay off: enable traces, screenshots, and video on failure (`trace: 'on-first-retry'`).
For a *visual* module (map capture, grid alignment) those artifacts are the fastest path to the cause.
And be honest about CI: running Foundry in CI needs the app, a license, and a world, so E2E often
lives in a local or self-hosted-runner lane rather than hosted CI — say so in the test's docs instead
of wiring it into a pipeline that can't get a license.

Any document a Playwright test creates persists into a real world — clean it up via the bridge or an
in-page `evaluate` by exact id, or run against a disposable world and document that assumption.

> **Reusable browser regression → a `@playwright/test` spec in `<module>/e2e`, run by `ui_test`. One-off browser-level drive that needs login or
> two clients → Playwright MCP. One-off in-world check inside the running client → MCP live bridge.**
> Don't reach for a `@playwright/test` spec to answer a question a single interactive probe could.

---

## Before reporting success

- [ ] `git status` reviewed before and after edits.
- [ ] Unit tests run with scoped `node --test test/*.test.mjs` (or the repo's script).
- [ ] Edited JS passed `node --check` / lint / build.
- [ ] Quench tests run in a live client whenever runtime APIs are involved.
- [ ] MCP bridge connectivity confirmed before any live verification.
- [ ] Foundry reloaded after on-disk module changes, before live checks.
- [ ] Recent console errors read and either fixed or explicitly noted as unrelated.
- [ ] Every scene/actor/item/setting/user the tests created was cleaned up (or left only by request).
- [ ] Any persistent world mutation — especially user-role changes — was authorized and reverted.

## Common pitfalls

1. **Node-importing Foundry globals.** Top-level `game`/`foundry` throws on import. Extract pure
   logic; access globals lazily.
2. **Bare `node --test`.** It recurses into `test/quench/` and `test/e2e/`. Scope the glob.
3. **Quench batches loading for normal users.** Register only inside `quenchReady`.
4. **Cleanup only in `afterEach`.** A crash leaks data; add a module-prefixed `before` sweep too.
5. **Programmatic Quench run with no result window.** Some v14 builds throw unless the results window
   is open/auto-shown first. (See the reference.)
6. **Stuck Quench runner.** Reload Foundry before rerunning — wedged state poisons later runs.
7. **Assuming GM view == player view.** Use MCP `targetUser` or a Playwright player login for
   player-facing behavior.
8. **Expecting a hidden tab to repaint.** Background/headless pages can pause `requestAnimationFrame`;
   use a visible/headed client for render-loop regressions.
9. **`waitForTimeout` in Playwright.** Wait on real Foundry signals instead.
10. **Unpacking a live world's pack in place.** A running world locks its pack LevelDB — copy the pack
    dir and unpack the copy. And `--in` is the *parent* dir; `-n` names the pack subdir.
11. **Hardcoding the local environment.** Teach discovery; keep machine/world/user specifics in local
    project notes, not in a portable test or skill.
