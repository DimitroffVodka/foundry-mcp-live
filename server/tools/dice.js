/**
 * Dice + item-use tools.
 *
 *   - `roll`     — evaluate a dice formula, optional rig for forced face values
 *   - `use_item` — trigger an item on an actor and capture the resulting cards
 */
import { z }                  from "zod";
import { registerRoutedTool, AUDIT_DESC } from "./_helpers.js";

export function registerDiceTools(mcp) {
  registerRoutedTool(mcp, "roll",
    "Evaluate a dice formula. Optional `rig` array forces successive dice to specific face values " +
    "(e.g. rig:[15] on a d20 check gives a 15). Values past the queue roll normally.",
    {
      formula: z.string().describe("Roll formula, e.g. '2d20kh + 5' or '1d8+3'"),
      rig:     z.array(z.number()).optional().describe("Forced face values in roll order; clamped to each die's faces."),
    });

  registerRoutedTool(mcp, "use_item",
    "Trigger an item on an actor (weapon, spell, feature) and return the resulting chat " +
    "card as messages with full roll breakdowns. Use `rig` to force dice results for " +
    "deterministic pass/fail testing. For systems where the roll lives on the actor data " +
    "model (e.g. Shadowdark weapons → actor.system.rollAttack), this auto-routes to the " +
    "system's native method and returns its authentic card. For structured " +
    "attack->hit->damage->apply results use `request` with action `itemUse` instead (d20-style systems " +
    "+ Shadowdark NPCs).",
    {
      actor:  z.string().describe("Actor id or name."),
      item:   z.string().describe("Item id or name on that actor."),
      rig:    z.array(z.number()).optional().describe("Forced face values for dice that roll during the use."),
      method: z.string().optional().describe("Override the item method to call. Default: 'use' or 'roll'. Disables the system auto-route."),
      attackType: z.enum(["melee", "ranged"]).optional().describe("Shadowdark weapons only: force the attack ability — 'melee' (STR) or 'ranged' (DEX, e.g. throwing a thrown weapon). Default uses the weapon's own type."),
      audit:  z.boolean().optional().describe(AUDIT_DESC),
    });
}
