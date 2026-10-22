> Adapted from [Nave20/foundry-v14-system-skill](https://github.com/Nave20/foundry-v14-system-skill) (MIT, © 2026 Nave20; licence in `../LICENSE-foundry-v14-system-skill.md`), checked by its author against Foundry 14.369. It was written for game systems. In a module: use your module id where the examples say `mysys` (flags, settings, i18n keys, CSS), paths under `modules/<id>/` instead of `systems/mysys/`, and `module.json` instead of `system.json`. A module defines document subtypes or `dataModels` only if its `module.json` declares `documentTypes`. If the module also supports V13, see the V13 note in `../SKILL.md` before using a V14-only API.

# V14 changes relevant to system developers (14.349 → 14.369)

Compiled from the official release notes (https://foundryvtt.com/releases/14.3xx) and checked against the 14.369 source.
Timeline: Prototype 14.349–353 · Development 354–355 · Testing 356–358 · **Stable 1 = 14.359** (2026-04-01) … **Stable 11 = 14.369** (2026-10-08).

## Breaking or deprecated, by area

### Package / manifest
- **`template.json` is deprecated** (14.352). Use `documentTypes` in the manifest plus a `TypeDataModel` per subtype.
- An optional `type: "system" | "module"` manifest field was added. New manifest flags can silence warnings about deliberate unknown keys. Modules can declare compatibility with a system *generation*.
- Package updates now check the website repository rather than the upstream manifest (14.366). Signatures use the cleaned manifest (14.369).
- Worlds can no longer be installed from Setup; use Adventures instead. Quick-Start adventures and a new World Creation screen were added.
- Expired deprecations: `CONFIG.ActiveEffect.legacyTransferral` (since V11) and a large set of V12-era deprecations are **removed**.

### Data models and documents
- `updateSource`/`update` special keys `-=` / `==` are deprecated in favour of the operators **`_del`** and **`_replace(value)`** (`foundry.data.operators`).
- Cleaning was consolidated under `DataModel.cleanData(data, options)`. Validation now runs inside the `_updateDiff` / `_updateCommit` workflow.
- `SchemaField#extendFields` / `#removeFields` were added. `DataField#placeholder` (localized) was added. `DataModel#getNearestDocument` (14.368) was added.
- `Document.create` uses `this.implementation`. `Document#persisted` was added. `foundry.documents.modifyBatch` batches writes across collections.
- `DocumentStatsField.createdTime` / `modifiedTime` are now required.
- Each document class has a `metadata.baseTypeAllowed`. **Actor and Item: false** (system subtypes are mandatory).
- `@readonly` members are now really read-only.
- `CONFIG[documentName].embedHandlers` was added, plus `TypeDataModel#onEmbed`.
- Relative UUIDs were extended (`foundry.utils.buildRelativeUuid`, `DocumentUUIDField({relative: true})`).
- `TokenDocument#detectionModes` became a `TypedObjectField`. `ActorDelta` can be `null`.

### Active Effects V2
- **`ActiveEffect#changes` moved to `ActiveEffect#system.changes`** (14.353).
- **`mode` (a number) became `type` (a string)**: `custom | multiply | add | subtract | downgrade | upgrade | override` (14.352).
- `phase` (`initial`/`final`, extensible) and `priority` were added, and changes are applied guided by their DataField.
- `EffectChangeData#value` is stored JSON-parsed. Changes can reference actor data with `@`.
- `ActiveEffect#origin` is a `DocumentUUIDField`. ActiveEffect is a primary document (sidebar and compendium).
- Durations gained units and `expiry` events, and an expiry registry was added. Effects can target Token data.
- `CONFIG.statusEffects` changed from an array to an object keyed by id (with a backward-compatibility shim).
- `ActiveEffect#shouldApplyChange` (14.365) and `ActiveEffect#getReplacementData` (14.366) are now overridable.

### Rolls and chat
- **Chat Message Visibility Modes replace Roll Modes** (14.355). Use `messageMode` (`public|gm|blind|self|ic`) and the setting `core.messageMode`. The `rollMode` option is deprecated until V16.
- `ChatLog.MESSAGE_PATTERNS` is deprecated in favour of `ChatLog.CHAT_COMMANDS` (removed in V16).
- The chat input is now an inline ProseMirror editor.
- Booleans in Roll formulas evaluate to 0/1. `Roll.replaceFormulaData` uses a custom `toString` on objects.
- **`MeasuredTemplate` documents were removed**, absorbed into Scene Regions (the Region layer has a "Measured Template" mode). Systems that placed templates must create Regions (`RegionLayer#placeRegion`, `RegionDocument.createTokenEmanation`).

### Applications / UI
- **TinyMCE was removed** (ProseMirror only).
- `ApplicationV2` can render in a pop-out browser window (`detachWindow`). Use `this.element.ownerDocument` rather than the global `document`.
- `ApplicationV2.instances()`, `_getFrameButtons`, `_refit`, and middle-click actions were added. `_canRender` receives `isFirstRender`.
- HeaderControls and ContextMenu share a unified API. `ContextMenuEntry#icon` accepts class names, and `ContextMenu` supports `cssClass` (14.369).
- The `preRender` hook was added.
- `game.i18n.format` was merged into `game.i18n.localize(key, data)`, and the global alias `_loc` was added.
- New UI elements: `HTMLFormulaInputElement` (`<formula-input>`), `FormulaEditor`, and an Autocompletion menu API.

### Canvas (only if your system touches it)
- Scene **Levels** (multi-level scenes) were added, with a `Level` document concept, `Scene#getSurfaces`, and elevation-aware vision and sound.
- The anchor or pivot changed for Tiles and `RectangleShapeData`. `layerClass` in CONFIG is deprecated.
- Token movement API: `TokenDocument#move` resolves at the end, plus planned movement, `Scene#moveTokens`, and `CONFIG.Token.movement.actions`.
- Darkness and wall fixes. Line-of-sight checks consider the viewed level and the token's level.

## Migration checklist for an older (V11–V13) system

1. Delete `template.json`. Make sure every subtype has a `TypeDataModel` and appears in `documentTypes`.
2. Replace `ActorSheet` / `ItemSheet` (AppV1) with `HandlebarsApplicationMixin(ActorSheetV2/ItemSheetV2)`. Rewrite `getData` as `_prepareContext` and `activateListeners` as `actions` / `_onRender`. Remove jQuery.
3. Register sheets with `foundry.applications.apps.DocumentSheetConfig.registerSheet`.
4. Rewrite effect handling: `effect.system.changes`, `type` strings, phases. Change status effects to an object.
5. Replace `rollMode` with `messageMode`, `CONST.DICE_ROLL_MODES` with `CONFIG.ChatMessage.modes`, and `renderChatMessage` with `renderChatMessageHTML`.
6. Replace `"-=key": null` with `_del`, and `game.i18n.format` with `localize`.
7. Replace measured templates with Regions.
8. Replace globals with namespaced APIs (`foundry.applications.handlebars.*`, `foundry.applications.ux.TextEditor.implementation`, `foundry.utils.*`).
9. Run with the console open (F12) and fix every `logCompatibilityWarning` (they say `since: X, until: Y`).
