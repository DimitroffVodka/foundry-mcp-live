/**
 * Dice + item-use tools.
 *
 *   - `roll`     — evaluate a dice formula or draw from a RollTable, optional rig for forced face values
 *   - `use_item` — trigger an item on an actor and capture the resulting cards
 */
import { z }                  from "zod";
import { registerRoutedTool, registerRawTool, TARGET_USER_DESC, AUDIT_DESC } from "./_helpers.js";
import { callFoundry }        from "../lib/foundry-rpc.js";

export function registerDiceTools(mcp) {
  registerRawTool(mcp, "roll",
    "Roll dice or draw from a RollTable; the result is posted to chat. "
    + "Give `formula` to evaluate dice, or `table` to draw from a RollTable with Foundry's own "
    + "RollTable#draw — nested tables, drawn-result tracking (replacement off) and the chat card "
    + "come for free; use this rather than evaluate with table.draw(). Call `list {type:'rollTable'}` "
    + "first to find the table. Optional `rig` array forces successive dice to specific face values "
    + "(e.g. rig:[15] on a d20 check gives a 15; on a table it picks the row). Values past the queue roll normally.",
    {
      formula:     z.string().optional().describe("Roll formula, e.g. '2d20kh + 5' or '1d8+3'. Omit when drawing from `table`."),
      table:       z.string().optional().describe("RollTable id, exact name, or UUID (e.g. 'Compendium.x.tables.RollTable.abc') to draw from instead of rolling a formula."),
      displayChat: z.boolean().optional().describe("[table] Post the draw to chat. Default true; false draws silently and only returns the result."),
      reset:       z.boolean().optional().describe("[table] Put every drawn result back before drawing (for tables without replacement that ran out)."),
      rig:         z.array(z.number()).optional().describe("Forced face values in roll order; clamped to each die's faces."),
      targetUser:  z.string().optional().describe(TARGET_USER_DESC),
    },
    async ({ targetUser, table, displayChat, reset, ...rest }) => {
      if (table) return callFoundry("draw_table", { table, displayChat, reset, rig: rest.rig }, targetUser);
      if (!rest.formula) return { content: [{ type: "text", text: "Error: roll needs `formula` or `table`." }] };
      return callFoundry("roll", rest, targetUser);
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
