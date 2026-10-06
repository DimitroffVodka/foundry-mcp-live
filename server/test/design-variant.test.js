import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { GENERATED_MARKER, discardVariant, scanTemplates, writeVariant } from "../lib/design-variant.js";

function module_() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "var-"));
  const fx = path.join(root, "tools", "design-harness", "fixtures");
  fs.mkdirSync(fx, { recursive: true });
  fs.writeFileSync(path.join(root, "module.json"), "{}");
  fs.writeFileSync(path.join(fx, "win.mjs"), `export default {
    width: 300, css: "base{}", classes: ["a"],
    build: (s) => ({ parts: [{ id: "h", template: "templates/win-header.hbs", context: { s } }, { id: "l", template: "templates/win-list.hbs", context: {} }] }),
  };`);
  fs.writeFileSync(path.join(fx, "win-proposed.mjs"), `import current from "./win.mjs"; export default { ...current };`);
  fs.writeFileSync(path.join(fx, "hand.mjs"), "export default {};");
  return { root, fx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const load = (file) => import(pathToFileURL(file).href + `?t=${Math.random()}`).then((m) => m.default);

test("writeVariant generates a loadable fixture that swaps templates, appends css and overrides scalars", async () => {
  const m = module_();
  try {
    const r = writeVariant(m.root, {
      name: "v1", base: "win", css: ".x{color:red}", title: 'a "quoted"\nTitle', width: 420, classes: ["sde-ui"],
      templates: { "templates/win-list.hbs": "<ul>{{#each rows}}<li>{{name}}</li>{{/each}}</ul>" },
    });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(r.known.sort(), ["templates/win-header.hbs", "templates/win-list.hbs"]);
    const src = fs.readFileSync(r.fixtureFile, "utf8");
    assert.ok(src.startsWith(GENERATED_MARKER));
    const w = await load(r.fixtureFile);
    const built = w.build("order");
    assert.equal(built.parts[0].template, "templates/win-header.hbs", "untouched template stays");
    assert.equal(built.parts[1].template, "tools/design-harness/variants/v1/win-list.hbs", "swapped, module-relative");
    assert.equal(fs.readFileSync(path.join(m.root, built.parts[1].template), "utf8"), "<ul>{{#each rows}}<li>{{name}}</li>{{/each}}</ul>");
    assert.equal(w.width, 420); assert.equal(w.title, 'a "quoted"\nTitle'); assert.deepEqual(w.classes, ["sde-ui"]);
    assert.equal(built.css, "\n.x{color:red}", "css appended (base build() had none)");
    assert.equal(w.css, "base{}\n.x{color:red}", "top-level css appended after the base's");
  } finally { m.cleanup(); }
});

test("writeVariant never runs caller text as code", async () => {
  const m = module_();
  try {
    const evil = '"; process.exit(7); //` ${process.exit(8)} \\';
    const r = writeVariant(m.root, { name: "evil", base: "win", css: evil, title: evil, templates: { "templates/win-list.hbs": evil } });
    assert.equal(r.error, undefined);
    const w = await load(r.fixtureFile);   // would exit the test process if text were evaluated
    assert.equal(w.title, evil);
    assert.ok(w.css.endsWith(evil));
  } finally { m.cleanup(); }
});

test("writeVariant refuses what it should", () => {
  const m = module_();
  try {
    const e = (a) => writeVariant(m.root, { base: "win", css: "x", ...a }).error;
    assert.match(e({ name: "../esc" }), /`name` must be/);
    assert.match(e({ name: "_hidden/x" }), /`name` must be/);
    assert.match(e({ name: "win" }), /must differ/);
    assert.match(e({ name: "n", base: "nope" }), /no base fixture/);
    assert.match(e({ name: "hand" }), /hand-written fixture/);
    assert.match(e({ name: "n", templates: { "../../etc/x.hbs": "x" } }), /relative \.hbs path/);
    assert.match(e({ name: "n", templates: { "/abs/x.hbs": "x" } }), /relative \.hbs path/);
    assert.match(e({ name: "n", templates: { "a/x.hbs": "1", "b/x.hbs": "2" } }), /share the file name/);
    assert.match(e({ name: "n", templates: { "x.txt": "1" } }), /relative \.hbs path/);
    assert.match(e({ name: "n", css: undefined }), /nothing to vary/);
    assert.match(e({ name: "n", width: -3 }), /width/);
    assert.match(e({ name: "n", classes: ["a b"] }), /classes/);
    assert.match(e({ name: "n", css: "x".repeat(200_001) }), /css must be/);
    assert.ok(!fs.existsSync(path.join(m.root, "tools", "design-harness", "variants")), "a rejected call leaves nothing behind");
    assert.equal(fs.readFileSync(path.join(m.fx, "hand.mjs"), "utf8"), "export default {};", "hand-written fixture untouched");
  } finally { m.cleanup(); }
});

test("writeVariant refuses to write through a symlink", () => {
  const m = module_();
  const outside = fs.mkdtempSync(path.join(tmpdir(), "var-out-"));
  try {
    fs.mkdirSync(path.join(m.root, "tools", "design-harness", "variants"), { recursive: true });
    fs.symlinkSync(outside, path.join(m.root, "tools", "design-harness", "variants", "sneaky"));
    const r = writeVariant(m.root, { name: "sneaky", base: "win", css: "x", templates: { "templates/a.hbs": "x" } });
    assert.match(r.error, /symlink/);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing escaped");
  } finally { m.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("writeVariant overwrites its own variant, warns about template keys the base does not mention", () => {
  const m = module_();
  try {
    assert.equal(writeVariant(m.root, { name: "v", base: "win", css: "a" }).error, undefined);
    const again = writeVariant(m.root, { name: "v", base: "win", css: "b", templates: { "templates/nope.hbs": "x" } });
    assert.equal(again.error, undefined, "own generated variant may be rewritten");
    assert.deepEqual(again.unmatched, ["templates/nope.hbs"]);
    assert.ok(fs.readFileSync(again.fixtureFile, "utf8").includes('"b"'));
  } finally { m.cleanup(); }
});

test("scanTemplates follows sibling fixture imports and survives cycles", () => {
  const m = module_();
  try {
    assert.deepEqual([...scanTemplates(m.fx, "win-proposed")].sort(), ["templates/win-header.hbs", "templates/win-list.hbs"]);
    fs.writeFileSync(path.join(m.fx, "a.mjs"), 'import b from "./b.mjs"; export default {t:"templates/a.hbs"};');
    fs.writeFileSync(path.join(m.fx, "b.mjs"), 'import a from "./a.mjs"; export default {t:"templates/b.hbs"};');
    assert.deepEqual([...scanTemplates(m.fx, "a")].sort(), ["templates/a.hbs", "templates/b.hbs"]);
  } finally { m.cleanup(); }
});

test("discardVariant removes only what write_variant generated", () => {
  const m = module_();
  try {
    const w = writeVariant(m.root, { name: "v", base: "win", templates: { "templates/win-list.hbs": "x" } });
    assert.ok(fs.existsSync(w.templateFiles[0]));
    const d = discardVariant(m.root, "v");
    assert.equal(d.removed.length, 2);
    assert.ok(!fs.existsSync(w.fixtureFile) && !fs.existsSync(path.dirname(w.templateFiles[0])));
    assert.match(discardVariant(m.root, "hand").error, /not generated by write_variant/);
    assert.ok(fs.existsSync(path.join(m.fx, "hand.mjs")));
    assert.match(discardVariant(m.root, "ghost").error, /no fixture/);
    assert.match(discardVariant(m.root, "../x").error, /`name` must be/);
  } finally { m.cleanup(); }
});
