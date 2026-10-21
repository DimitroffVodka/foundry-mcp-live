# Quench + Foundry v14 — Troubleshooting Reference

Version-specific details rot fast. Treat this as a symptom→action guide and **verify the installed
Quench and Foundry versions in the live world first** — don't diagnose from a remembered version.

## Preflight

In the client console or via MCP `evaluate`:

```js
return {
  foundry: game.version,
  quenchActive: game.modules.get("quench")?.active,
  quenchVersion: game.modules.get("quench")?.version,
  autoShow: game.settings.get("quench", "autoShowQuenchWindow"),
};
```

After any failed run, also read recent client errors (`get_console_errors`).

## Symptom → action

| Symptom | Likely cause | Action |
|---|---|---|
| Runner stuck `state: "running"`, `failures: 1, tests: 0` | Quench wedged before tests started (often snapshot/result setup) | Reload Foundry; check Quench build compatibility; avoid snapshots until verified |
| Error in `QuenchResults.handleRunBegin` / `_setElementDisabled` / `querySelector` | Programmatic run began before the results window rendered | Set `quench.autoShowQuenchWindow = true`, or open the beaker/results window before `runBatches()` |
| Snapshot assertions fail before real assertions | Snapshot manager path incompatible with this Foundry/Quench combo | Avoid `toMatchSnapshot`, or confirm Quench snapshot support on this Foundry version first |
| Later runs fail instantly after one bad run | Wedged runner/global state leaked | `reload_foundry` before rerunning |

## v14 note captured in the field

In one Foundry v14 world, Quench `0.10.0` wedged because its snapshot manager called a removed
`FilePicker` path. A local build with `module.json` `compatibility.verified` bumped to `"14"` cleared
it. That's evidence for *that* environment, not a universal fact — re-check upstream before carrying a
fork, and prefer the official build once it supports your Foundry version.

## Programmatic run template

```js
await game.settings.set("quench", "autoShowQuenchWindow", true);   // avoid the no-results-window throw
const result = await quench.runBatches(["my-module.feature"], { json: true });
return {
  stats: result.stats,
  failures: result.failures?.map(f => ({ title: f.title, error: String(f.err || f) })),
};
```

If it wedges, `reload_foundry` before another attempt — a wedged runner poisons subsequent runs.

## Batch hygiene (recap of the SKILL body)

- Register only inside `Hooks.on("quenchReady", ...)`; lazy-import the batch module.
- Batch ids start with the package id (`my-module.import`).
- Use `function () {}` callbacks wherever you call `this.timeout(ms)` — arrows have no `this`.
- Add a `before` sweep for leftover, module-prefixed test docs from a crashed prior run.
- Delete created documents by **exact id** in `afterEach` / `after`.
- Restore any setting or active scene the test changed.

## Crash-safe cleanup pattern

```js
before(async function () {
  const stale = game.scenes.filter(s => s.name.startsWith("Test my-module ")).map(s => s.id);
  if (stale.length) await Scene.deleteDocuments(stale);
});

afterEach(async function () {
  if (created.length) await Scene.deleteDocuments(created.splice(0));
});
```

Always scope the prefix to your module so a sweep can never delete unrelated documents.
