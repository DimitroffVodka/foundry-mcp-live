> Adapted from [Nave20/foundry-v14-system-skill](https://github.com/Nave20/foundry-v14-system-skill) (MIT, © 2026 Nave20; licence in `../LICENSE-foundry-v14-system-skill.md`), checked by its author against Foundry 14.369. It was written for game systems. In a module: use your module id where the examples say `mysys` (flags, settings, i18n keys, CSS), paths under `modules/<id>/` instead of `systems/mysys/`, and `module.json` instead of `system.json`. A module defines document subtypes or `dataModels` only if its `module.json` declares `documentTypes`. If the module also supports V13, see the V13 note in `../SKILL.md` before using a V14-only API.

# Documents, CRUD, hooks, settings — V14

Source: `client/documents/*.mjs`, `common/abstract/document.mjs`, `common/documents/*.mjs`.

## Custom Document classes

```js
// module/documents/actor.mjs
export default class MySysActor extends Actor {
  /** Data available to roll formulas as @path */
  getRollData() {
    const data = { ...super.getRollData() };   // = a copy of this.system
    data.lvl = this.system.level;
    return data;
  }

  async applyDamage(amount) {
    const hp = this.system.health;
    return this.update({ "system.health.value": Math.max(0, hp.value - amount) });
  }

  /** @inheritDoc */
  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    if (this.type === "character") this.updateSource({ prototypeToken: { actorLink: true } });
  }
}
// entry file, in init:
CONFIG.Actor.documentClass = MySysActor;
```

- Always create documents through `Actor.implementation` / `Item.implementation` (or `getDocumentClass("Actor")`), so the configured class is used.
- Every Document type can be subclassed: `Actor`, `Item`, `ActiveEffect`, `ChatMessage`, `Combat`, `Combatant`, `TokenDocument`, `JournalEntryPage`, `RollTable`, `User`…
- **Actor and Item have `baseTypeAllowed: false`.** The system must declare at least one subtype of each, and every Actor or Item must have a declared `type`. `ActiveEffect`, `ChatMessage`, `Combat`, `Combatant`, `Card` and others allow the `"base"` type.
- `this.system` is the TypeDataModel instance. `this._source.system` is the raw stored data.
- Embedded collections: `actor.items`, `actor.effects`. Use `actor.itemTypes` (grouped by type) and `actor.appliedEffects`. Items of an actor: `item.actor` / `item.parent`.

## CRUD

```js
const actor = await Actor.implementation.create({ name: "Hero", type: "character" });
await Actor.implementation.createDocuments([{...}, {...}]);           // batch
await actor.update({ "system.level": 2 });
await Actor.implementation.updateDocuments([{ _id, "system.level": 3 }]);
await actor.delete();
await actor.createEmbeddedDocuments("Item", [{ name: "Sword", type: "weapon" }]);
await actor.updateEmbeddedDocuments("Item", [{ _id: item.id, "system.equipped": true }]);
await actor.deleteEmbeddedDocuments("Item", [id1, id2]);
await Actor.implementation.createDialog(data = {}, createOptions = {}, dialogOptions = {}); // "create" dialog with type list
const doc = await fromUuid("Actor.abc123.Item.def456");                // any document by UUID
const sync = fromUuidSync(uuid);                                       // no compendium fetch
```

Operation options (the second argument): `{ render: false, diff: false, recursive: false, noHook: true, pack: "world.x", parent }`, plus any custom keys, which are forwarded to hooks and `_on*` callbacks.

V14 additions: `foundry.documents.modifyBatch([...])` batches writes across several collections, `Document#persisted` tells whether a document is saved, and `Scene#moveTokens` moves several tokens at once.

## Document lifecycle (override on the Document or on its TypeDataModel)

| Method | Runs on | Use |
|---|---|---|
| `async _preCreate(data, options, user)` | creating client | adjust with `this.updateSource()`, return `false` to cancel |
| `_onCreate(data, options, userId)` | all clients | side effects (guard on `userId === game.user.id` before writing) |
| `async _preUpdate(changes, options, user)` | updating client | inspect or mutate `changes`, return `false` to cancel |
| `_onUpdate(changed, options, userId)` | all clients | |
| `async _preDelete(options, user)` / `_onDelete(options, userId)` | | |
| static `_preCreateOperation(documents, operation, user)` etc. | batch level | |

## Hooks (global events)

```js
Hooks.once("init", fn);        // register CONFIG, classes, settings, sheets, handlebars
Hooks.once("i18nInit", fn);    // translations loaded (localize CONFIG labels here if needed)
Hooks.once("setup", fn);       // after init, before documents are ready
Hooks.once("ready", fn);       // world fully loaded (V14: fires after scene transitions); migrations go here
Hooks.on("preCreateActor", (doc, data, options, userId) => {});   // return false to cancel
Hooks.on("createItem", (doc, options, userId) => {});
Hooks.on("updateActor", (doc, changed, options, userId) => {});
Hooks.on("deleteItem", (doc, options, userId) => {});
Hooks.on("renderActorSheetV2", (app, element, context, options) => {});  // element = HTMLElement
Hooks.on("renderChatMessageHTML", (message, html, context) => {});        // html = HTMLElement
Hooks.on("getActorContextOptions", (app, entries) => {});                 // directory context menu
Hooks.on("hotbarDrop", (bar, data, slot) => {});                          // create macros from drops
Hooks.on("preRender", ...);                                               // V14: tweak render data
```

The naming pattern is `pre{Action}{DocumentName}` / `{action}{DocumentName}`, and `render{ApplicationClassName}` for each class in the inheritance chain. Hook logging: `CONFIG.debug.hooks = true`.

## Settings

```js
game.settings.register("mysys", "autoDamage", {
  name: "MYSYS.Settings.autoDamage.name", hint: "MYSYS.Settings.autoDamage.hint",
  scope: "world",           // "world" (GM, stored in DB) | "client" (localStorage) | "user"
  config: true,             // visible in the settings UI
  type: Boolean,            // or a DataField instance: new foundry.data.fields.NumberField({min:0})
  default: true,
  requiresReload: false,
  onChange: value => {}
});
game.settings.get("mysys", "autoDamage");
await game.settings.set("mysys", "autoDamage", false);
game.settings.registerMenu("mysys", "advanced", { name, label, icon, type: MyAppV2Class, restricted: true });
```

## Flags (data outside the schema)

`doc.getFlag("mysys", "key")`, `await doc.setFlag("mysys", "key", value)`, `await doc.unsetFlag("mysys", "key")`.
Use flags for module-style extras. Core system data belongs in the schema.

## CONFIG entries a system typically sets in `init`

```js
CONFIG.MYSYS = MYSYS;                                  // your constants (abilities, etc.)
CONFIG.Actor.documentClass / dataModels / trackableAttributes
CONFIG.Item.documentClass / dataModels
CONFIG.ActiveEffect.documentClass / dataModels
CONFIG.Combat.initiative = { formula: "1d20 + @abilities.dex.mod", decimals: 2 };
CONFIG.Dice.rolls.push(MyRoll);                        // custom Roll subclasses
CONFIG.statusEffects = { stunned: { id: "stunned", name: "MYSYS.Status.stunned", img: "..." } };  // V14: object
CONFIG.Actor.trackableAttributes = { character: { bar: ["health"], value: ["level"] } };
```

`trackableAttributes` controls which attributes can be shown as token bars (`bar`, which needs `value`/`max`) or values. Without it, Foundry infers them from the schema.

## Socket (system.json `"socket": true`)

```js
game.socket.on("system.mysys", data => { /* runs on the other clients */ });
game.socket.emit("system.mysys", { action: "ping" });
```

User queries (V13+, `User.queryMany` added in V14) are the preferred way to ask a GM client to perform a privileged update. Register `CONFIG.queries["mysys.doThing"] = async (queryData, {timeout}) => result` in `init`, then call `await game.users.activeGM.query("mysys.doThing", data, {timeout: 5000})`. The querying user needs the `QUERY_USER` permission. Check the handler signature in `client/documents/collections/users.mjs` before relying on its exact arguments.

## Permissions

`doc.isOwner`, `doc.testUserPermission(game.user, "OBSERVER")`, `doc.canUserModify(user, "update")`, `game.user.isGM`, `doc.ownership`. Only the GM, or an owner, can update a document. Route player-triggered changes to documents they do not own through a GM, using a query or a socket.
