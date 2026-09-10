import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The e2e world fixture is mostly opaque bytes (a LevelDB), and the failure
// mode is silent: `.gitignore` carries a blanket `*.log`, which is exactly
// where a freshly seeded record lives until something compacts it into a
// `.ldb`. Commit a regenerated fixture without compacting and you get a world
// that looks complete, opens with zero records, leaves every module disabled,
// and fails E2E with "no bridge connected" — pointing nowhere near the cause.
//
// Reading it properly needs `classic-level`, which is not a dependency here
// (the seeder borrows Foundry's copy). Scanning the raw bytes is enough: the
// record is stored as JSON text either way.

const FIXTURE = fileURLToPath(
  new URL("../e2e/fixtures/worlds/mcp-smoke/", import.meta.url)
);

test("fixture world.json declares the system the workflow installs", () => {
  const world = JSON.parse(readFileSync(`${FIXTURE}world.json`, "utf8"));
  assert.equal(world.id, "mcp-smoke");
  assert.equal(world.system, "shadowdark");
  assert.ok(world.systemVersion, "systemVersion pins what e2e.yml downloads");
  assert.ok(world.coreVersion, "coreVersion must be set or Foundry migrates on launch");
});

test("fixture settings database is present and non-empty", () => {
  const files = readdirSync(`${FIXTURE}data/settings`);
  assert.ok(
    files.some((f) => f.endsWith(".ldb") || f.endsWith(".log")),
    `settings dir has no data files (.ldb/.log), only: ${files.join(", ")}. ` +
    "A LevelDB write-ahead log may have been swallowed by the blanket *.log " +
    "rule in .gitignore — see the negation there."
  );
});

test("fixture enables this module, or no bridge will ever connect", () => {
  const dir = `${FIXTURE}data/settings`;
  const blob = readdirSync(dir)
    .map((f) => readFileSync(`${dir}/${f}`, "latin1"))
    .join("");

  assert.match(
    blob,
    /core\.moduleConfiguration/,
    "no core.moduleConfiguration record in the fixture settings database"
  );
  assert.match(
    blob,
    /foundry-mcp-live/,
    "the moduleConfiguration record does not mention this module"
  );
  assert.doesNotMatch(
    blob,
    /"foundry-mcp-live\\?":\s*false/,
    "the fixture has this module explicitly disabled"
  );
});
