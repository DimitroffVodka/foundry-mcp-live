---
name: foundry-v14
description: Use when writing, reviewing or updating Foundry VTT module code that must run on V14 (build 14.369), and when a console shows a V14 compatibility warning. Covers the V14 API changes that break or warn in older code (AppV2 sheets, ActiveEffect system.changes, message modes, _del/_replace update operators, Regions instead of measured templates, namespaced globals), keeping V13 support, and where to check an API before guessing.
---

# Foundry VTT V14 for module developers

Target: Foundry VTT V14, build 14.369. Most tutorials and older modules were written for V10–V12. Code copied from them either breaks in V14 or logs a compatibility warning that turns into a break in V16.

The `references/` files come from a skill written for game systems (see the header in each). The API knowledge applies to modules unchanged. The system scaffolding does not, so the manifest reference and the system template were left out.

## Check before you guess

In this order:

1. **The installed core source.** It ships unminified in the Foundry app folder (`resources/app` in the desktop app; the folder holding `main.mjs` for a Node install): `client/` for client classes, `common/` for schemas, data fields and constants, `templates/` for core Handlebars. Grep it for the exact signature before writing a call.
2. **The live world**, through this plugin's foundry-vtt tools:
   - `get_data_model` returns a document type's real schema in the running build.
   - `evaluate` can probe an API in the running build. Read-only checks only, and prefer a dedicated tool when one exists.
   - After exercising new code, `get_console_errors` (level `warn`) shows every `logCompatibilityWarning`. Each one names `since` and `until`. Fix them before shipping.
3. **The online API docs** at https://foundryvtt.com/api/ (labelled 14.368; 14.369 only added fixes and a `cssClass` option on `ContextMenu`).
4. **A real V14 codebase**: `foundryvtt/dnd5e` v6.x on GitHub. Knowledge Base articles are conceptually fine but their examples still show older versions.

## V14 rules that trip people up

| Do this in V14 | Not this (legacy) |
|---|---|
| `foundry.applications.api.HandlebarsApplicationMixin(ApplicationV2)`, and `ActorSheetV2` / `ItemSheetV2` from `foundry.applications.sheets` | `Application`, `FormApplication`, `ActorSheet`, `ItemSheet` (AppV1, now under `foundry.appv1.*`, removed in V16) |
| `static DEFAULT_OPTIONS`, `static PARTS`, `static TABS`, `actions` with `data-action` | `defaultOptions`, `getData`, `activateListeners` with jQuery |
| `_prepareContext(options)` returns the context; `this.element` is a plain `HTMLElement` | `getData()`, `html.find(...)` |
| `this.element.ownerDocument` (an app can pop out into another window) | the global `document` |
| `foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, id, Sheet, {...})` | `Actors.registerSheet(...)` |
| ActiveEffect changes in `effect.system.changes`, each with a string `type` (`"add"`, `"override"`…) and a `phase` | `effect.changes` with a numeric `mode` / `CONST.ACTIVE_EFFECT_MODES` |
| `roll.toMessage(data, { messageMode })` with `public` / `gm` / `blind` / `self` / `ic`; setting `core.messageMode` | `rollMode`, `core.rollMode`, `CONST.DICE_ROLL_MODES` |
| `{"system.foo": _del}` and `{"system.foo": _replace(value)}` (`foundry.data.operators`) | `"system.-=foo": null`, `"system.==foo"` keys |
| `game.i18n.localize(key, data)` or the `_loc(key, data)` alias | `game.i18n.format` (merged into `localize`) |
| Scene Regions (the Region layer's measured-template mode, `RegionLayer#placeRegion`) | `MeasuredTemplate` documents (removed) |
| `Hooks.on("renderChatMessageHTML", (message, html) => …)`, `html` an `HTMLElement` | `renderChatMessage` with jQuery |
| `ChatLog.CHAT_COMMANDS` | `ChatLog.MESSAGE_PATTERNS` |
| `CONFIG.statusEffects` as an object keyed by id | an array (still shimmed) |
| `foundry.applications.handlebars.loadTemplates` / `renderTemplate`, `foundry.applications.ux.TextEditor.implementation` | the bare globals `loadTemplates`, `renderTemplate`, `TextEditor` |
| Scene Levels: a placeable or token belongs to a Level; check the token's own Level for walls and vision | assuming one floor per scene |

`references/v14-changes.md` has the full list from the release notes.

## If the module also supports V13

A `module.json` with `compatibility.minimum` 13 runs on both, and several V14 APIs do not exist in V13. Feature-detect and fall back instead of branching on the version string:

- Update operators: use `foundry.data?.operators?.ForcedDeletion` (V14) when it exists, the `-=` key otherwise.
- Effect changes: read `effect.system?.changes ?? effect.changes`. Reading `effect.changes` first on V14 goes through a migration shim.
- Message modes: V13 has no `messageMode`. Pass it only where `CONFIG.ChatMessage.modes` exists, else `rollMode`.
- Namespaced globals: `foundry.applications.ux.TextEditor?.implementation ?? globalThis.TextEditor`, and the same pattern for `loadTemplates` and `renderTemplate`.
- Sheets: AppV2 exists in V13 too (since V12), so new sheets can be AppV2 on both.

## Module conventions

- Namespace everything with the module id: flags (`flags.<id>`), settings (`game.settings.register("<id>", …)`), i18n keys, and a root CSS class.
- Register in `Hooks.once("init")`, and do work that needs the world or the canvas in `Hooks.once("ready")` or `canvasReady`.
- Use only the public API. The `@protected` methods (`_prepareContext`, `_onRender`, `_preCreate`…) are meant to be overridden; always call `super`. `@readonly` members really are read-only in V14.
- Patching another package's code: use its API or hooks if it has them, and a wrapper library such as libWrapper otherwise. Never replace a core method outright.

## References — read only what the task needs

| File | Read it when |
|---|---|
| `references/v14-changes.md` | migrating older code, or anything that "worked in V12/V13" |
| `references/sheets-appv2.md` | any sheet or application: PARTS, TABS, actions, forms, drag and drop, templates, CSS |
| `references/active-effects.md` | effects, conditions, status effects, change types and phases |
| `references/rolls-chat.md` | dice, roll data, chat cards, message modes, initiative and combat |
| `references/documents.md` | custom document classes, CRUD, update operators, flags, lifecycle hooks, settings, sockets |
| `references/data-models.md` | TypeDataModel schemas and field types, for module-defined subtypes or settings |
