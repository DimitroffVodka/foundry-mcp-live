/**
 * SystemStateAdapter for Shadowdark (checked against the 4.0.6 data model:
 * src/models/PlayerSD.mjs and _ActorBaseSD.mjs). Player actors keep coins in
 * system.coins.{gp,sp,cp} and HP in system.attributes.hp.{value,max}, which the
 * base adapter already uses.
 */
import { BaseSystemStateAdapter } from "@thefehr/foundry-playwright";

export const SHADOWDARK_COINS = ["gp", "sp", "cp"];

export class ShadowdarkStateAdapter extends BaseSystemStateAdapter {
  id = "shadowdark";

  getTestActorData() {
    return { type: "Player", system: { attributes: { hp: { value: 10, max: 10 } } } };
  }

  getTestItemData() {
    return { type: "Basic", system: {} };
  }

  async grantCurrency(page, actorName, amount, currency) {
    if (!SHADOWDARK_COINS.includes(currency)) throw new Error(`Shadowdark coins are ${SHADOWDARK_COINS.join("/")}, not "${currency}"`);
    return page.evaluate(({ actorName, amount, currency }) => {
      const actor = window.game.actors.getName(actorName);
      if (!actor) throw new Error(`Actor not found: ${actorName}`);
      return actor.update({ [`system.coins.${currency}`]: (actor.system.coins?.[currency] ?? 0) + amount });
    }, { actorName, amount, currency });
  }

  getCurrencyVerifyParams() {
    return {
      key: "actor-update",
      predicate: (data, extra = {}) => data.name === extra.actorName
        && (data.delta?.[`system.coins.${extra.currency}`] ?? data.delta?.system?.coins?.[extra.currency]) === extra.amount,
    };
  }
}
