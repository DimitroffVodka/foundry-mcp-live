# Playwright E2E for Foundry — Reference

Read this before writing any Playwright test against Foundry. Playwright is the slowest, most fragile
layer; it earns its place only when the **browser workflow itself** is under test (login, session,
storage, downloads, headed/headless, focus/blur, backgrounded-tab repaint). For everything else, a
Quench test or an MCP probe is cheaper and steadier.

Playwright shows up in two forms here — the **`@playwright/test`** suite (a reusable regression, most
of this doc) and **Playwright MCP** (`@playwright/mcp`, an interactive/agentic browser driver). They
answer different questions; pick the surface first — see §11.

## Table of contents

1. Good fits vs. wrong fits
2. Setup
3. Auth via saved `storageState` (do this first)
4. Determinism: wait on Foundry signals, never sleep
5. Backgrounding a tab on purpose (the visibility/rAF case)
6. Headed vs headless
7. Artifacts: traces, video, screenshots
8. CI reality
9. Cleanup
10. Session contention
11. Playwright MCP vs. `@playwright/test`

## 1. Good fits vs. wrong fits

**Good fits** — only a real browser reaches these:
- `/join` login flow and session contention
- browser storage/session bugs
- iframe export interception, downloads, uploads
- headed-vs-headless differences
- focus/blur and backgrounded-tab / `requestAnimationFrame` regressions

**Wrong fits** — push these down a layer:
- document/hook/setting/data-model behavior → Quench
- pure logic/parsers/math → `node:test`
- "did it work right now?" → MCP live probe

## 2. Setup

```sh
npm install --save-dev @playwright/test
npx playwright install chromium
```

Prefer scripts that already exist in the repo. Otherwise:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed"
  }
}
```

Environment, with overridable defaults (read in `playwright.config`, not hardcoded in each test):

```sh
FOUNDRY_URL=http://localhost:30000
FOUNDRY_USER=Gamemaster
FOUNDRY_PASSWORD=
```

```sh
# bash / zsh / fish
env FOUNDRY_USER=Test2 FOUNDRY_PASSWORD= npm run test:e2e
```
```powershell
# PowerShell
$env:FOUNDRY_USER = "Test2"; $env:FOUNDRY_PASSWORD = ""; npm run test:e2e
```

## 3. Auth via saved `storageState` (do this first)

Logging in inside every test is the dominant source of Foundry E2E flakiness, and it collides with
session contention (Foundry greys out an already-connected user). Instead, **log in once in a setup
project and reuse the saved session.** Every real test starts already authenticated.

```js
// playwright.config.js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: { baseURL: process.env.FOUNDRY_URL ?? "http://localhost:30000" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.js/ },
    {
      name: "e2e",
      dependencies: ["setup"],
      use: { storageState: "playwright/.auth/gm.json" },
    },
  ],
});
```

```js
// auth.setup.js — runs once, saves the authenticated session
import { test as setup, expect } from "@playwright/test";

setup("authenticate as GM", async ({ page }) => {
  const user = process.env.FOUNDRY_USER ?? "Gamemaster";
  await page.goto("/join");
  await page.selectOption('select[name="userid"]', { label: user });
  if (process.env.FOUNDRY_PASSWORD) {
    await page.fill('input[name="password"]', process.env.FOUNDRY_PASSWORD);
  }
  await page.click('button[name="join"]');
  // wait for the world to actually be live, not just for navigation (see §4)
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  await page.context().storageState({ path: "playwright/.auth/gm.json" });
});
```

Add `playwright/.auth/` to `.gitignore` — it holds a live session.

## 4. Determinism: wait on Foundry signals, never sleep

`page.waitForTimeout(ms)` is why Foundry E2E suites rot: the right delay on your machine is the wrong
delay in CI. Foundry boots asynchronously through a long hook chain, so wait on **its** state:

- `game.ready === true` — world fully initialized
- a specific hook — set a flag from `Hooks.once("canvasReady", ...)` etc. and wait for it
- a DOM selector that only exists post-ready (e.g. `#board`, a control you rendered)
- a `window.__test*` flag your own code sets when an async operation finishes

```js
// wait for game ready
await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });

// wait for a specific hook by exposing a flag
await page.evaluate(() => new Promise(res => Hooks.once("canvasReady", res)));

// wait for your own async op via a namespaced flag (pairs with the "fire-and-forget" pattern)
await page.waitForFunction(() => globalThis.__myModuleTest?.done === true, null, { timeout: 60000 });
```

For long synchronous work, don't poll inside one call — kick it off, store progress on
`window.__myModuleTest`, and let `waitForFunction` poll from outside the blocked call.

## 5. Backgrounding a tab on purpose (the visibility/rAF case)

This is the regression class that *only* this layer catches, and the part naive attempts get wrong.
The tempting shortcut — a `node:test` that fakes `requestAnimationFrame` and asserts a blank buffer —
tests your *model* of the bug, not the bug; it never loads the browser, so it can't catch the real
repaint/capture failure. Use it (if at all) only to document the mechanism, never as the primary
regression. Two facts:

- A real backgrounded tab throttles or pauses `requestAnimationFrame`, so render-loop engines
  (Pixi/WebGL/OpenFL canvases) stop repainting — which is exactly the bug.
- **Headless Chromium frequently does not reproduce this**, because it has no real foreground/visible
  concept. So a visibility bug can pass headless and still be broken for users. Run these headed.

Two ways to force the original page into the background:

**A — a second page in the same context, brought to the front (closest to real user behavior):**

```js
test("capture still works when the tab is backgrounded", async ({ context, page }) => {
  await page.goto("/game");
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });

  const other = await context.newPage();          // open a second tab...
  await other.goto("about:blank");
  await other.bringToFront();                      // ...and put `page` in the background

  // trigger the capture/render-driven action on the now-background page
  await page.evaluate(() => globalThis.myModule.startCapture());
  await page.waitForFunction(() => globalThis.__myModuleTest?.done === true, null, { timeout: 60000 });

  const blank = await page.evaluate(() => globalThis.__myModuleTest.resultIsBlank);
  expect(blank).toBe(false);                       // the regression would make it blank
  await other.close();
});
```

**B — a CDP visibility override (deterministic, no second window):**

```js
const client = await context.newCDPSession(page);
await client.send("Emulation.setPageVisibilityOverride", { hidden: true }); // and { hidden: false } to restore
```

CDP is Chromium-only. Prefer (A) when you want to mirror real user behavior; use (B) for a precise,
windowless toggle. Either way, run headed for render-loop bugs.

## 6. Headed vs headless

- **Headless** — smoke tests, login, DOM flows, downloads. Fast; fine for most CI.
- **Headed required** — anything involving `requestAnimationFrame`, visible canvas repaint,
  focus/blur, tab visibility, or OS/browser dialogs.

Tag headed-only tests and keep them out of the headless lane:

```js
test("backgrounded-tab repaint @headed", async ({ page }) => { /* ... */ });
// run lane:  npx playwright test --headed --grep @headed
// skip lane: npx playwright test --grep-invert @headed
```

## 7. Artifacts: traces, video, screenshots

The fragility tax is only worth paying if failures are debuggable. Turn on artifacts — for a *visual*
module they're the fastest route to the cause:

```js
// playwright.config.js -> use:
use: {
  trace: "on-first-retry",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
}
```

`npx playwright show-trace test-results/.../trace.zip` replays the run with DOM + network + console.

## 8. CI reality

Running Foundry in hosted CI needs the application, a paid license, and an installed world — none of
which a stock GitHub-hosted runner has. Be honest about where E2E runs:

- a **local** lane developers run before pushing, or
- a **self-hosted runner** with a pinned Foundry version + world.

Document the prerequisite in the test file / dev docs. Don't wire E2E into a hosted pipeline that
can't get a license and will only ever red-X.

## 9. Cleanup

Documents a Playwright test creates persist into a real world. Clean up by exact id through an in-page
`evaluate` or the MCP bridge:

```js
await page.evaluate(async (id) => { await game.scenes.get(id)?.delete(); }, sceneId);
```

Or run the suite against a **disposable test world** and state that assumption at the top of the test
file. Never broad-delete by a loose name match against a shared world.

## 10. Session contention

Foundry greys out an already-connected user on `/join`. If an MCP bridge or another tab holds the
default GM, Playwright can't log in as that user. In order of preference:

1. Use a **dedicated test GM** user (cleanest; no contention with your live session).
2. Close the tab / stop the bridge that holds the user.
3. With **explicit** approval, temporarily promote a test user, run, then revert — this is a
   persistent world mutation, so never do it unprompted and always revert:

```js
await game.users.getName("Test2").update({ role: CONST.USER_ROLES.GAMEMASTER });
// run E2E as Test2
await game.users.getName("Test2").update({ role: CONST.USER_ROLES.PLAYER });
```

## 11. Playwright MCP vs. `@playwright/test`

There are two distinct ways to point Playwright at Foundry. They are **not** competing test
frameworks — one is for *exploring*, the other for *regressing*.

| | **Playwright MCP** (`@playwright/mcp`) | **`@playwright/test`** |
|---|---|---|
| Mode | interactive / agentic — you drive it tool-call by tool-call | scripted — a `.spec.js` you write once and rerun |
| Best for | one-off browser-level checks: multi-context **GM-vs-player**, `/join` login & session lifecycle, network-fault / reconnect, "does this work right now across two clients?" | the durable, CI/local-lane **regression** (storageState auth, headed backgrounded-tab repaint, traces) |
| Analogue | the Layer-4 counterpart of the **MCP live bridge** | the Layer-4 suite this whole doc describes |

Think of Playwright MCP as the MCP live bridge for things *outside* the in-client bridge's reach: the
bridge runs *inside* one logged-in client, so it can't drive login, can't hold two user sessions at
once, and can't sever the socket. Playwright MCP drives the browser from outside, so it can.

**It is canvas-blind.** Accessibility snapshots (`browser_snapshot`) don't include the WebGL board —
the canvas is opaque to the a11y tree. Read in-world state with `browser_evaluate`, exactly like the
bridge's `evaluate`, and with the same payload discipline (return small plain JSON, project the fields
you need):

```js
// via Playwright MCP browser_evaluate — read structured state, don't screenshot the canvas
() => ({ ready: game?.ready === true, scene: canvas?.scene?.name, users: game.users.size })
```

**The headless software-WebGL CPU trap still applies** (see `mcp-live-verification.md`): an MCP-driven
headless Chromium rasterizes the Foundry canvas on the CPU. Pre-seed **`core.noCanvas`** before the
board renders (an init script or the client setting) so the driver doesn't peg the CPU, and remember
you still can't fully `--disable-gpu` or Foundry never reaches `game.ready`.

**Multi-context GM-vs-player:** open a second tab/context (`browser_tabs`) logged in as a different
user, and read each side independently with `browser_evaluate`. The session-contention rules in §10
apply — use a **dedicated player user**, don't fight your live GM session for the connection.

**Capture the durable version.** Once an interactive MCP drive confirms a flow, port it to a
`@playwright/test` spec so it becomes a regression — same Layer-3→Layer-1 discipline the skill applies
to the MCP live bridge.
