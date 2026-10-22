> Adapted from [Nave20/foundry-v14-system-skill](https://github.com/Nave20/foundry-v14-system-skill) (MIT, © 2026 Nave20; licence in `../LICENSE-foundry-v14-system-skill.md`), checked by its author against Foundry 14.369. It was written for game systems. In a module: use your module id where the examples say `mysys` (flags, settings, i18n keys, CSS), paths under `modules/<id>/` instead of `systems/mysys/`, and `module.json` instead of `system.json`. A module defines document subtypes or `dataModels` only if its `module.json` declares `documentTypes`. If the module also supports V13, see the V13 note in `../SKILL.md` before using a V14-only API.

# Dice, Chat & Combat — V14

Source: `client/dice/roll.mjs`, `client/documents/chat-message.mjs`, `client/config.mjs` (`ChatMessage.modes`), `client/documents/combat.mjs`.

## Rolling

```js
const roll = new Roll("1d20 + @abilities.str.mod + @prof", actor.getRollData(), { flavor: "Strength" });
await roll.evaluate();                 // async (needed for interactive / manual dice fulfillment)
roll.total; roll.dice; roll.terms; roll.result;
roll.evaluateSync({ strict: false });  // only for deterministic formulas (no dice), e.g. computing a modifier
Roll.validate("2d6+3");                // is the formula syntactically valid?

await roll.toMessage({
  speaker: ChatMessage.implementation.getSpeaker({ actor }),
  flavor: _loc("MYSYS.Roll.Attack", { name: item.name })   // V14: localize also formats
}, { messageMode: "public" });         // omit it to use the user's current mode (setting core.messageMode)
```

- **Message modes (V14)** replace roll modes: `CONFIG.ChatMessage.modes` = `public`, `gm` (private to GMs), `blind`, `self`, `ic` (in-character). The current choice is in `game.settings.get("core", "messageMode")`. Passing `rollMode` still works but prints a deprecation warning (until V16), and `CONST.DICE_ROLL_MODES` is legacy.
- Roll data: `@path` resolves against the object passed as `data`. Return useful shortcuts from `Actor#getRollData()`.
- Formula syntax: `4d6kh3` (keep highest 3), `1d20x` (exploding), `2d20kl` (keep lowest), `1d10r1` (reroll 1s), `5d10cs>=8` (count successes ≥ 8), `{1d20, 10}kh` (pool), `1d6[fire]` (flavor), `@lvl` data, math functions `floor()`, `ceil()`, `max()`. V14 evaluates booleans in formulas as 0/1.
- Custom Roll class: `class MyRoll extends Roll { static CHAT_TEMPLATE = "systems/mysys/templates/chat/roll.hbs"; }`, then `CONFIG.Dice.rolls.push(MyRoll)` so it can be rebuilt from chat messages.
- Custom die: extend `foundry.dice.terms.Die`, set `static DENOMINATION = "s"`, and register `CONFIG.Dice.terms.s = MyDie`.

## Example: an "ability check" method on the Actor

```js
async rollAbility(key, { messageMode } = {}) {
  const ability = this.system.abilities[key];
  const label = _loc(CONFIG.MYSYS.abilities[key]);
  const roll = new Roll("1d20 + @mod", { mod: ability.mod });
  await roll.toMessage({
    speaker: ChatMessage.implementation.getSpeaker({ actor: this }),
    flavor: _loc("MYSYS.Roll.AbilityCheck", { ability: label })
  }, { messageMode });
  return roll;
}
```

## Chat messages without a roll

```js
const content = await foundry.applications.handlebars.renderTemplate("systems/mysys/templates/chat/item-card.hbs", { item, actor });
await ChatMessage.implementation.create(ChatMessage.applyMode({
  author: game.user.id,                 // V12+: `author`, not `user`
  speaker: ChatMessage.implementation.getSpeaker({ actor }),
  content,
  rolls: [],                            // you may attach evaluated rolls
  flags: { mysys: { itemUuid: item.uuid } }
}, game.settings.get("core", "messageMode")));
```

- `ChatMessage.applyMode(data, mode)` sets `whisper` and `blind`. `ChatMessage.getWhisperRecipients("GM")` returns the GM users.
- The `style` field uses `CONST.CHAT_MESSAGE_STYLES` (`OTHER`, `OOC`, `IC`, `EMOTE`).
- Interactive chat cards: listen in `Hooks.on("renderChatMessageHTML", (message, html, context) => {...})`. `html` is an **HTMLElement** (the jQuery `renderChatMessage` hook is deprecated). Attach click listeners to `[data-action]` inside it, and re-check permissions (`message.isOwner`, `game.user.isGM`) in the handler.
- A system can define ChatMessage subtypes (a data model plus `documentTypes.ChatMessage`) and override `renderHTML` for fully custom cards.
- Chat commands: `ChatLog.CHAT_COMMANDS` (V14) replaces `ChatLog.MESSAGE_PATTERNS`.

## Combat & initiative

```js
CONFIG.Combat.initiative = { formula: "1d20 + @abilities.dex.mod", decimals: 2 };  // or "initiative" in system.json
```

- Override `Combatant#getInitiativeRoll(formula)` or `Combatant#_getInitiativeFormula()` (check the signature in `client/documents/combatant.mjs`) for per-actor formulas.
- `actor.rollInitiative({ createCombatants: true, rerollInitiative: false, initiativeOptions: { messageMode } })`.
- Turn order: override `Combat#_sortCombatants(a, b)`. In V14 it decides the actual order, not just the display.
- Combat hooks: `combatStart`, `combatTurn`, `combatRound`, `combatTurnChange`, `updateCombat`. V14 added `Combat#name`, and the ActiveEffect registry reacts to turn and round events (expiry).
- Token bars: `CONFIG.Actor.trackableAttributes` (see `documents.md`). Resources with value 0 now display in the tracker (14.364 fix).
