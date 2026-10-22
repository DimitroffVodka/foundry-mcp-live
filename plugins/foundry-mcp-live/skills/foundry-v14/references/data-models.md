> Adapted from [Nave20/foundry-v14-system-skill](https://github.com/Nave20/foundry-v14-system-skill) (MIT, © 2026 Nave20; licence in `../LICENSE-foundry-v14-system-skill.md`), checked by its author against Foundry 14.369. It was written for game systems. In a module: use your module id where the examples say `mysys` (flags, settings, i18n keys, CSS), paths under `modules/<id>/` instead of `systems/mysys/`, and `module.json` instead of `system.json`. A module defines document subtypes or `dataModels` only if its `module.json` declares `documentTypes`. If the module also supports V13, see the V13 note in `../SKILL.md` before using a V14-only API.

# System Data Models (TypeDataModel) — V14

Source: `common/abstract/data.mjs` (DataModel, TypeDataModel), `common/data/fields.mjs`, `common/data/_types.mjs`.

## Contents
1. Defining and registering
2. Field reference
3. Field options
4. Shared fields and inheritance
5. Data preparation (base / derived)
6. Lifecycle hooks on the model
7. Migrations
8. Localization of fields (LOCALIZATION_PREFIXES)
9. Updating data (operators `_del`, `_replace`)

---

## 1. Defining and registering

```js
// module/data/actor-character.mjs
const { HTMLField, NumberField, SchemaField, StringField } = foundry.data.fields;

export default class CharacterData extends foundry.abstract.TypeDataModel {
  /** Automatic labels: MYSYS.Actor.Character.FIELDS.<path>.label / .hint */
  static LOCALIZATION_PREFIXES = ["MYSYS.Actor.base", "MYSYS.Actor.Character"];

  static defineSchema() {
    return {
      health: new SchemaField({
        value: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
        max:   new NumberField({ required: true, integer: true, min: 0, initial: 10 })
      }),
      level: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      biography: new HTMLField({ required: true, blank: true })
    };
  }

  prepareDerivedData() {
    this.health.value = Math.clamp(this.health.value, 0, this.health.max);
  }
}
```

Register it in `init`, and declare the same key in `system.json → documentTypes`:

```js
Hooks.once("init", () => {
  CONFIG.Actor.dataModels.character = CharacterData;     // or assign the whole object
  CONFIG.Item.dataModels = { weapon: WeaponData, skill: SkillData };
});
```

Inside the model, `this` is the `system` object and `this.parent` is the owning Document (Actor, Item…). `foundry.abstract.TypeDataModel` is the base for every subtype. ActiveEffect subtypes extend `foundry.data.ActiveEffectTypeDataModel` instead, because it provides `changes` (see `active-effects.md`).

## 2. Field reference (`foundry.data.fields.*`)

| Field | Stores | Notes |
|---|---|---|
| `StringField` | string | `blank`, `trim`, `choices` (array, object or function), `textSearch` |
| `NumberField` | number | `integer`, `min`, `max`, `step`, `positive`, `choices`. `nullable` defaults to true, so set `nullable: false` with an `initial` |
| `BooleanField` | boolean | initial `false` |
| `HTMLField` | HTML string | **declare it in `htmlFields`** in system.json; rendered as `<prose-mirror>` by `formInput` |
| `JavaScriptField`, `JSONField` | code / JSON text | |
| `FilePathField` | path | `categories: ["IMAGE"]`, `base64` |
| `ColorField` | `#rrggbb` | |
| `AlphaField`, `AngleField`, `HueField` | constrained numbers | |
| `SchemaField` | nested object | `new SchemaField({...})`. Use `schema.extendFields({...})` / `removeFields([...])` (V14) |
| `ArrayField` | array | `new ArrayField(new StringField())`; `min`/`max` length |
| `SetField` | Set (stored as an array) | unique values |
| `ObjectField` | free-form object | no validation of the content; prefer a schema |
| `TypedObjectField` | `{[key]: element}` dictionary | `new TypedObjectField(new SchemaField({...}))`; `validateKey` |
| `TypedSchemaField` | polymorphic objects | discriminated by a `type` key |
| `EmbeddedDataField` | nested DataModel | `new EmbeddedDataField(MyModel)` |
| `DocumentUUIDField` | a document UUID | `type: "Item"`, `relative: true` (V14) |
| `ForeignDocumentField` | id of a world document | `new ForeignDocumentField(foundry.documents.BaseActor)` |
| `DocumentIdField` | 16-character id | |
| `AnyField` | anything | |

Choices example:

```js
rarity: new StringField({ required: true, blank: false, initial: "common",
  choices: () => CONFIG.MYSYS.rarities })   // { common: "MYSYS.Rarity.common", ... }
```

## 3. Field options (`DataFieldOptions`)

`required`, `nullable`, `initial` (value or `(data) => value`), `readonly`, `gmOnly` (can only be changed by a GM), `persisted:false` (never written to the database), `label`, `hint`, `placeholder` (all localizable), `validate(value, options)` (throw or return false), `validationError`.

Rules of thumb:
- Set `required: true` plus an `initial` on most leaf fields, so documents always have a value and templates never see `undefined`.
- For numbers that may be empty, use `nullable: true` and `initial: null`.
- Do **not** put derived values (modifiers, totals, levels computed from XP) in the schema. Compute them in `prepareDerivedData` and assign them to `this`. They are not persisted, which is what you want.

## 4. Shared fields and inheritance

Two common patterns:

```js
// a) Base class
class BaseActorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return { health: resourceField(10), biography: new HTMLField() };
  }
}
class NpcData extends BaseActorData {
  static defineSchema() {
    return { ...super.defineSchema(), cr: new NumberField({ initial: 1 }) };
  }
}

// b) Helper function returning a field
function resourceField(initial) {
  return new SchemaField({
    value: new NumberField({ required: true, integer: true, min: 0, initial }),
    max:   new NumberField({ required: true, integer: true, min: 0, initial })
  });
}
```

## 5. Data preparation

Order in which an Actor is prepared (verified in `client/documents/abstract/client-document.mjs` and `actor.mjs`):

1. `system.prepareBaseData()`, then `actor.prepareBaseData()`
2. `prepareEmbeddedDocuments()`: items and effects are prepared, then `applyActiveEffects("initial")`
3. `system.prepareDerivedData()`, then `actor.prepareDerivedData()`
4. `applyActiveEffects("final")`. Changes whose `phase` is `"final"` therefore see the derived values.

- `prepareBaseData`: values that effects should be able to modify (base ability scores, defaults).
- `prepareDerivedData`: computed values (modifiers, totals, encumbrance), clamping.
- Items are prepared **before** the actor's derived data, so the actor can aggregate item data. An item that needs actor data should read it lazily (a getter), or override `prepareFinalAttributes` in your own code.
- Expose roll data by overriding `getRollData()` on the Document. The default returns a copy of `this.system`, and you can add shortcuts (`@str`, `@lvl`). See `rolls-chat.md`.

## 6. Lifecycle hooks on the model

A `TypeDataModel` can override hooks that run alongside the Document's own:
`async _preCreate(data, options, user)` (return `false` to cancel), `_onCreate(data, options, userId)`, `async _preUpdate(changes, options, user)`, `_onUpdate(changed, options, userId)`, `async _preDelete(options, user)`, `_onDelete(options, userId)`.

Use `this.parent.updateSource({...})` inside `_preCreate` to change initial data (for example a default image per type). `_on*` hooks run on **every** client. Guard any write with `if (game.user.id !== userId) return;`.

## 7. Migrations

```js
static migrateData(source) {
  // source can be FULL data (loaded from disk) or a PARTIAL update delta: test before using
  if ("hp" in source && !("health" in source)) source.health = { value: source.hp, max: source.hp };
  return super.migrateData(source);
}
```

- `migrateData` runs on load **and** on every update delta, so make it idempotent and tolerant of partial input.
- Use `static shimData(data)` to add backward-compatible read aliases with deprecation warnings.
- For heavy, one-time migrations, store a `schemaVersion` world setting and update documents in a `ready` hook (GM only). Use `Actor.updateDocuments([...])` in batches, and also migrate compendium packs: `pack.getDocuments()` after `pack.configure({locked:false})`.

## 8. Localization of fields

`static LOCALIZATION_PREFIXES = ["MYSYS.Actor.Character"]`. Foundry then automatically localizes the `label` and `hint` of every field registered on a document subtype, using the keys:

```json
{ "MYSYS": { "Actor": { "Character": { "FIELDS": {
  "health": { "label": "Health", "value": { "label": "Current" }, "max": { "label": "Maximum" } },
  "level":  { "label": "Level", "hint": "Character level (1-20)" }
}}}}}
```

Nested fields follow the schema path. With several prefixes, later prefixes override earlier ones. For models that are not registered as a subtype (for example a setting's model), call `foundry.helpers.Localization.localizeDataModel(Model)` in `i18nInit`.

Subtype names shown in creation dialogs use `TYPES.Actor.character`, `TYPES.Item.weapon` in the lang file:

```json
{ "TYPES": { "Actor": { "character": "Character", "npc": "NPC" }, "Item": { "weapon": "Weapon" } } }
```

## 9. Updating data — V14 operators

```js
await actor.update({ "system.health.value": 5 });                 // dot-notation path
await actor.update({ system: { health: { value: 5 } } });          // nested object
await actor.update({ "system.tags.temporary": _del });             // delete a key   (V14; replaces "-=key")
await actor.update({ "system.skills": _replace({ athletics: 2 }) }); // replace a whole object (replaces "==key")
await actor.update({ "flags.mysys.-=foo": null });                 // legacy: still works, prints a deprecation warning
```

`_del` and `_replace` are globals (`foundry.data.operators.ForcedDeletion` / `ForcedReplacement`). They are mostly useful with `ObjectField` and `TypedObjectField` keys. Updating an array field replaces the whole array, so build the new array and pass it in.
