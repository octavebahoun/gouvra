import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * WCAG 2.2 AA audit of the current page with axe-core: no serious or critical violation allowed.
 * Animations are settled first so colour-contrast checks see the final state.
 */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = blocking.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
  }));
  expect(summary, `axe violations on "${label}"`).toEqual([]);
}

/** The page never scrolls sideways (mobile overflow check). */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on "${label}"`).toBeLessThanOrEqual(0);
}
