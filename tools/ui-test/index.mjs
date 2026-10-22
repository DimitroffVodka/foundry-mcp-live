/**
 * What a module's e2e specs import:
 *
 *   import { test, expect } from "@foundry-mcp-live/ui-test";
 *
 * foundry-playwright's `test` (tour suppression, console monitoring, the
 * `foundry` state/ui/canvas helpers) plus one auto fixture: every test starts
 * joined to the sandbox world as `user` (default "Gamemaster", passwordless in
 * a fresh world). `test.use({ user: null })` starts on a blank page instead.
 * Everything else foundry-playwright exports is re-exported.
 */
import { test as base, disableTour, loginAs, registerSystemStateAdapter } from "@thefehr/foundry-playwright";
import { ShadowdarkStateAdapter } from "./adapters/shadowdark.mjs";

// dnd5e and pf2e ship with foundry-playwright; add other systems here.
registerSystemStateAdapter("shadowdark", (page) => new ShadowdarkStateAdapter(page));

export * from "@thefehr/foundry-playwright";
export { ShadowdarkStateAdapter };

export const test = base.extend({
  user: ["Gamemaster", { option: true }],
  joined: [async ({ page, user }, use) => {
    if (user) {
      await loginAs(page, user);
      // Again on the joined page: the fixture's init-script copy runs before <head> exists and never installs.
      await disableTour(page);
    }
    await use(Boolean(user));
  }, { auto: true }],
});
