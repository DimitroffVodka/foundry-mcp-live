# e2e fixtures

## `worlds/mcp-smoke`

The world the E2E workflow boots. It is one file — `world.json` — and that is
deliberate.

**Why there is no content here.** The obvious fixture is a copy of a real
world. A real world is the wrong thing to commit:

- Its `packs/` are world-level copies of third-party module compendia
  (Shadowdark Enhancer and friends). Committing them redistributes someone
  else's paid content.
- Its `assets/` are scene thumbnails generated from copyrighted maps.
- Its `data/` carries journals, chat logs and player accounts, which are
  nobody's business but the owner's, and megabytes of noise for a smoke test
  that only asks "did the bridge come up and answer".

So the fixture keeps the *shape* of a real Shadowdark v14 world — the same
`system`, `systemVersion` and `coreVersion` a real one declares — and none of
the content. Foundry initialises the empty collections on first launch, and
seeds a default **Gamemaster** user, which is the account the smoke test joins
as.

**What the workflow has to supply around it:**

| Need | How |
|---|---|
| The `shadowdark` system | Downloaded from its public GitHub release into `Data/systems/` |
| Launching the world | `FOUNDRY_WORLD=mcp-smoke` on the felddy container |
| The module itself | `module/` copied to `Data/modules/foundry-mcp-live` |
| The module *enabled* | Seeded into the world's `data/settings` — a virgin world has every module off, so without this no bridge ever connects |

**The settings database.** `worlds/mcp-smoke/data/settings` is a committed
LevelDB holding exactly one record: `core.moduleConfiguration`, with
`foundry-mcp-live` enabled. Regenerate it with
[`seed-settings.mjs`](seed-settings.mjs) rather than editing the bytes:

```bash
node server/e2e/fixtures/seed-settings.mjs server/e2e/fixtures/worlds/mcp-smoke
rm -f server/e2e/fixtures/worlds/mcp-smoke/data/settings/{LOCK,LOG,LOG.old}
```

`LOCK`, `LOG` and `LOG.old` are recreated by LevelDB on every open and are not
committed. The remaining `CURRENT`, `MANIFEST-*`, `*.ldb` and `*.log` are the
data.

⚠️ **Commit the `*.log` too.** A freshly seeded record lives only in LevelDB's
write-ahead log until something opens the database and compacts it into a
`.ldb`. The repo's `.gitignore` has a blanket `*.log` rule, so there is an
explicit negation for this directory — if you move or copy the fixture, check
`git status` actually lists the `.log`. Committing without it yields a world
that looks complete and opens with zero records, which surfaces in CI as "no
bridge connected" and points nowhere near the cause.
`server/test/e2e-fixture.test.js` guards against this.

**Bumping it.** When Foundry or Shadowdark move on, update `coreVersion`,
`compatibility` and `systemVersion` here and the system version pinned in
`.github/workflows/e2e.yml`. If a future Foundry stops accepting a world this
sparse, the fix is to add the missing keys to `world.json` — not to start
committing world content.
