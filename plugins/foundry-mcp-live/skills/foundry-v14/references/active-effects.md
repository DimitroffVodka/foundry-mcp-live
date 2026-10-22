> Adapted from [Nave20/foundry-v14-system-skill](https://github.com/Nave20/foundry-v14-system-skill) (MIT, © 2026 Nave20; licence in `../LICENSE-foundry-v14-system-skill.md`), checked by its author against Foundry 14.369. It was written for game systems. In a module: use your module id where the examples say `mysys` (flags, settings, i18n keys, CSS), paths under `modules/<id>/` instead of `systems/mysys/`, and `module.json` instead of `system.json`. A module defines document subtypes or `dataModels` only if its `module.json` declares `documentTypes`. If the module also supports V13, see the V13 note in `../SKILL.md` before using a V14-only API.

# Active Effects V2 — V14

Source: `common/documents/active-effect.mjs` (schema), `common/data/active-effect.mjs` (ActiveEffectTypeDataModel),
`client/documents/active-effect.mjs`, `common/constants.mjs` (ACTIVE_EFFECT_*).

## What changed in V14 (this breaks V13 code)

- Changes moved from `effect.changes` to **`effect.system.changes`**. The `system` is an `ActiveEffectTypeDataModel`, so every ActiveEffect subtype defines `changes`.
- `mode` (a number, `CONST.ACTIVE_EFFECT_MODES`) is replaced by **`type`** (a string). Reading `CONST.ACTIVE_EFFECT_MODES` prints a deprecation warning.
- Changes have a **`phase`** (`"initial"` | `"final"`, or one registered by the system) and an optional `priority`.
- `value` is stored parsed as JSON (a number stays a number) and may reference actor data with `@path`.
- Durations support units (`seconds`, `minutes`, `hours`, `days`, `months`, `years`, `rounds`, `turns`) and an `expiry` event (`combatStart`, `roundStart`, `turnStart`, `combatEnd`, `roundEnd`, `turnEnd`). An effect registry tracks expiry.
- ActiveEffect is now a **primary** document as well: it can live in the sidebar and in compendiums (`"type": "ActiveEffect"` packs).
- Effects can target Token data (light, etc.) and can be applied by a Region behavior. You can also drag an effect onto a token.
- The legacy `CONFIG.ActiveEffect.legacyTransferral` has been removed. Item effects with `transfer: true` apply to the owning actor.

## Change data

```js
{ key: "system.abilities.str.value", type: "add", value: 2, phase: "initial", priority: null }
```

| type | default priority | effect |
|---|---|---|
| `custom` | 0 | nothing; handled by the system (`_applyChangeCustom` / the `applyActiveEffect` hook) |
| `multiply` | 10 | numeric × value |
| `add` | 20 | +number, concatenate a string, push to an Array, add to a Set |
| `subtract` | 20 | −number, splice from an Array, delete from a Set (V14) |
| `downgrade` | 30 | keep the lower value |
| `upgrade` | 40 | keep the higher value |
| `override` | 50 | replace |

Lower priorities apply first. Custom string types (`"mysys.advantage"`, at least 3 characters, `[a-z0-9]` segments) are allowed. Register them in `CONFIG.ActiveEffect.changeTypes[type] = { label, defaultPriority, handler, render }`, and custom phases in `CONFIG.ActiveEffect.phases`. For a custom phase you must call `actor.applyActiveEffects("myPhase")` yourself at the right moment.

Changes are **guided by the DataField** at `key`: the target field casts the value (a number field gets a number). The `phase` decides when a change applies:
- `initial`: after `prepareBaseData` and embedded preparation, **before** `prepareDerivedData`. Use it for base stats that feed derived values.
- `final`: after `prepareDerivedData`. Use it for derived totals (for example, AC +1 on top of the computed AC).

## Creating effects

```js
await actor.createEmbeddedDocuments("ActiveEffect", [{
  name: "Bless", img: "icons/svg/angel.svg",
  type: "base",                                      // ActiveEffect allows the base type
  system: { changes: [{ key: "system.bonuses.attack", type: "add", value: 2 }] },
  duration: { value: 10, units: "rounds", expiry: "turnEnd" },
  statuses: ["blessed"],
  origin: item.uuid,                                  // DocumentUUIDField, relative allowed
  transfer: true,                                     // on Items: apply to the owning actor
  disabled: false
}]);
await actor.toggleStatusEffect("stunned", { active: true, overlay: false });
```

Useful getters: `actor.appliedEffects` (active and not suppressed), `actor.allApplicableEffects()` (generator, including transferred item effects), `actor.statuses` (Set of active status ids), `effect.active`, `effect.isSuppressed` (override it to suppress conditionally), `effect.isTemporary`, `effect.duration.remaining`.
Override `shouldApplyChange(change, {phase, replacementData})` on your ActiveEffect class (V14) to add conditions under which a change applies. Use `getReplacementData()` to add data for `@` references.

## System subtypes for ActiveEffect

```js
class ConditionData extends foundry.data.ActiveEffectTypeDataModel {
  static defineSchema() {
    const schema = super.defineSchema();                      // contains `changes`
    schema.changes.element.extendFields({ note: new foundry.data.fields.StringField() });  // extend change rows
    return { ...schema, severity: new foundry.data.fields.NumberField({ initial: 1 }) };
  }
}
Object.assign(CONFIG.ActiveEffect.dataModels, { condition: ConditionData });   // keep the core "base" model
// system.json: "documentTypes": { "ActiveEffect": { "condition": {} } }
```

## Status effects (V14: object keyed by id)

```js
CONFIG.statusEffects = {
  stunned: { id: "stunned", name: "MYSYS.Status.stunned", img: "systems/mysys/icons/stunned.svg",
             system: { changes: [{ key: "system.defense", type: "add", value: -2 }] } },   // status = ActiveEffect data
  dead: { id: "dead", name: "EFFECT.StatusDead", img: "icons/svg/skull.svg" }
};
CONFIG.specialStatusEffects.DEFEATED = "dead";   // also INVISIBLE, BLIND, BURROW, HOVER, FLY
```

## Showing effects on a sheet

List `actor.effects` (owned) together with transferred item effects, using `actor.allApplicableEffects()`. Open an effect with `effect.sheet.render({force: true})`, toggle it with `effect.update({disabled: !effect.disabled})`. Mark rows as `.draggable` with `data-effect-id` so that ActorSheetV2 drag & drop works.
