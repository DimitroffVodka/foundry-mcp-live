import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { forViewer, removeSecrets } from "../../module/lib/read-filter.js";
import { chatEvent } from "../../module/scripts/live-play.js";

const SECRET = '<section class="secret" id="secret-a1"><p>The duke is a vampire.</p></section>';

test("removeSecrets: unrevealed secret sections go, revealed and plain sections stay", () => {
  assert.equal(removeSecrets(`<p>Bio.</p>${SECRET}<p>End.</p>`), "<p>Bio.</p><p>End.</p>");
  const revealed = '<section class="secret revealed" id="secret-b"><p>Known now.</p></section>';
  assert.equal(removeSecrets(revealed), revealed);
  const plain = '<section class="notes"><p>ok</p></section>';
  assert.equal(removeSecrets(plain + SECRET), plain);
  assert.equal(removeSecrets('<section data-class="secret"><p>x</p></section>'), '<section data-class="secret"><p>x</p></section>');
  assert.equal(removeSecrets("no html"), "no html");
  assert.equal(removeSecrets(undefined), undefined);
});

test("removeSecrets: nesting, quoting variants and an unclosed secret", () => {
  assert.equal(removeSecrets('a<section class="secret"><section><p>in</p></section><p>still in</p></section>b'), "ab");
  assert.equal(removeSecrets("a<section class='x secret'>s</section>b"), "ab");
  assert.equal(removeSecrets("a<SECTION class=secret>s</SECTION>b"), "ab");
  assert.equal(removeSecrets('a<section title="1 > 0" class="secret">s</section>b'), "ab");
  // Fail closed: a secret that never closes takes the rest of the string with it.
  assert.equal(removeSecrets('a<section class="secret">never closed <p>more</p>'), "a");
});

const actorSource = () => ({
  _id: "a1", name: "Duke",
  system: { details: { biography: { value: `<p>Bio.</p>${SECRET}` } }, flags: { anything: 1 } },
  items: [{
    _id: "i1", name: "Ring", system: { description: { value: `<p>Gold.</p>${SECRET}` } },
    ownership: { default: 0, u2: 3 }, flags: { "gm-notes": { notes: "cursed" }, dnd5e: { x: 1 } },
  }],
  ownership: { default: 2, u1: 3, u2: 3 },
  flags: { core: { sheetClass: "s" }, dnd5e: { y: 2 }, "gm-notes": { notes: "<p>secretly the villain</p>" } },
});
const player = { isGM: false, isOwner: false, userId: "u9", level: 2, keepFlags: ["core", "dnd5e"] };

test("forViewer: a GM gets the data untouched", () => {
  const data = actorSource();
  assert.equal(forViewer(data, { ...player, isGM: true }), data);
});

test("forViewer: an observer loses secrets everywhere, other modules' flags and others' ownership", () => {
  const out = forViewer(actorSource(), player);
  assert.equal(out.system.details.biography.value, "<p>Bio.</p>");
  assert.equal(out.items[0].system.description.value, "<p>Gold.</p>");
  assert.deepEqual(out.flags, { core: { sheetClass: "s" }, dnd5e: { y: 2 } });
  assert.deepEqual(out.items[0].flags, { dnd5e: { x: 1 } });
  assert.deepEqual(out.ownership, { u9: 2 });
  assert.deepEqual(out.items[0].ownership, { u9: 2 });
  // A system field that happens to be called `flags` is the system's data, not document flags.
  assert.deepEqual(out.system.flags, { anything: 1 });
});

test("forViewer: an owner keeps secrets; flags: true keeps every namespace", () => {
  const out = forViewer(actorSource(), { ...player, isOwner: true, keepFlags: true });
  assert.match(out.system.details.biography.value, /vampire/);
  assert.equal(out.flags["gm-notes"].notes, "<p>secretly the villain</p>");
  assert.deepEqual(out.ownership, { u9: 2 });
});

test("chatEvent: secret blocks only for owners of the speaker's actor", () => {
  const msg = (speakerActor) => ({ id: "m", content: `<p>Card.</p>${SECRET}`, speakerActor });
  assert.equal(chatEvent(msg({ isOwner: false })).content, "Card.");
  assert.match(chatEvent(msg({ isOwner: true })).content, /vampire/);
  // No speaker actor and no GM user: stripped.
  assert.equal(chatEvent(msg(undefined)).content, "Card.");
});

// bridge.js cannot load in node (Foundry globals), so check the read handlers
// still route their document data through the filter. Removing a call fails here.
test("bridge.js: every routed document read goes through readAs / removeSecrets", () => {
  const src = readFileSync(fileURLToPath(new URL("../../module/scripts/bridge.js", import.meta.url)), "utf8");
  const body = (name) => {
    const start = src.indexOf(`\n  ${name}: `);
    assert.ok(start >= 0, `handler ${name} not found`);
    return src.slice(start, src.indexOf("\n  },\n", start));
  };
  for (const h of ["get_actor", "get_item", "get_compendium_document", "search_compendium", "get_data_model",
    "get_token_details", "snapshot_actors", "get_scene_placeables", "get_actor_items"]) {
    assert.match(body(h), /readAs\(/, h);
  }
  for (const h of ["get_chat_messages", "draw_table"]) assert.match(body(h), /removeSecrets\(/, h);
});
