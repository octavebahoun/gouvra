import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./support/a11y";
import {
  billingOf,
  createVerifiedUser,
  createWorkspace,
  promoteSuperadmin,
  signIn,
} from "./support/api";

/** Stripe's hosted Checkout, in test mode: the documented test card always succeeds. */
async function payWithTestCard(page: Page, name: string): Promise<void> {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  const card = page.locator("#cardNumber");
  const cardTab = page.locator('[data-testid="card-accordion-item-button"]');
  await expect(card.or(cardTab).first()).toBeVisible({ timeout: 30_000 });
  if (await cardTab.isVisible()) await cardTab.click();
  await card.fill("4242 4242 4242 4242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await page.locator("#billingName").fill(name);
  const postalCode = page.locator("#billingPostalCode");
  if (await postalCode.isVisible()) await postalCode.fill("75001");
  await page.locator('[data-testid="hosted-payment-submit-button"]').click();
}

test("subscribe to Team through Stripe Checkout in test mode", async ({ browser }) => {
  // Phase 9 exit criterion: the subscription journey, tested in test mode.
  test.setTimeout(180_000);
  const owner = await createVerifiedUser({ tag: "subscriber", name: "Katherine Johnson" });
  const workspace = await createWorkspace(owner, "Subscribers");
  const billing = await billingOf(owner, workspace.id);
  test.skip(billing.provider !== "stripe", "Stripe test mode is not configured on this stack");

  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  await page.goto(`/w/${workspace.slug}/settings/billing`);
  await expect(page.getByText("Stripe test mode — no real payment")).toBeVisible();
  const plan = page.locator("#plan");
  await expect(plan.getByText("Free", { exact: true })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Runs this month" })).toHaveAttribute(
    "aria-valuemax",
    "1000",
  );
  await expectAccessible(page, "billing (free)");

  // Upgrade: Stripe's page, the test card, then back to Gouvra.
  await page.getByRole("button", { name: "Upgrade to Team" }).click();
  await payWithTestCard(page, owner.name);
  await page.waitForURL(/\/settings\/billing/, { timeout: 60_000 });
  await expect(page.getByText("Payment received — activating the plan…")).toBeVisible();

  // The plan changes when Stripe's signed event arrives (relayed by `stripe listen`), not on
  // the redirect: the page keeps asking until it does.
  await expect(plan.getByText("Team", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(plan.getByText("Active", { exact: true })).toBeVisible();
  await expect(plan.getByText(/Renews on/)).toBeVisible();
  await expect(page.getByRole("meter", { name: "Runs this month" })).toHaveAttribute(
    "aria-valuemax",
    "20000",
  );
  await expect(page.getByRole("button", { name: /Manage subscription/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change in the portal" })).toBeVisible();

  // The change is in the audit log, attributed to Stripe.
  await page.goto(`/w/${workspace.slug}/settings/audit`);
  await expect(page.getByText("billing.subscription_changed").first()).toBeVisible();

  // The billing portal opens on Stripe for this customer.
  await page.goto(`/w/${workspace.slug}/settings/billing`);
  await page.getByRole("button", { name: /Manage subscription/ }).click();
  await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
  await context.close();
});

test("a budget, retention and exports, from the interface", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await createVerifiedUser({ tag: "budgeter" });
  const workspace = await createWorkspace(owner, "Budgeters");
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();

  // A monthly budget with a hard stop, drawn on the usage page.
  await page.goto(`/w/${workspace.slug}/usage`);
  await page.getByRole("button", { name: "Set a budget" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Limit per month/ }).fill("25");
  await dialog.getByRole("button", { name: "90 %" }).click();
  await dialog.getByRole("switch", { name: "Stop new runs at 100%" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Budget saved")).toBeVisible();
  await expect(page.getByText("of $25.00")).toBeVisible();
  await expect(page.getByText("Alerts at 50 %, 80 %, 90 %, 100 %")).toBeVisible();
  await expect(page.getByText("Stops new runs at 100%")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Monthly budget" })).toBeVisible();

  // Usage as CSV.
  const csv = page.waitForEvent("download");
  await page.getByRole("link", { name: "Runs CSV" }).click();
  const runs = await csv;
  expect(runs.suggestedFilename()).toMatch(/\.csv$/);
  expect((await readFile(await runs.path())).toString()).toMatch(/^id,created_at,agent/);

  // Retention and the configuration export, under Settings → Data.
  await page.goto(`/w/${workspace.slug}/settings/data`);
  await expect(page.getByRole("heading", { name: "Data retention" })).toBeVisible();
  const json = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export the configuration" }).click();
  const exported = JSON.parse((await readFile(await (await json).path())).toString()) as {
    format: string;
  };
  expect(exported.format).toBe("gouvra.export/v1");
  await page.getByRole("combobox", { name: /Runs, workflow runs and alerts/ }).click();
  await page.getByRole("option", { name: "7 days" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Retention saved")).toBeVisible();
  await context.close();
});

test("an administrator suspends a workspace and disables an account", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await createVerifiedUser({ tag: "tenant", name: "Hedy Lamarr" });
  const workspace = await createWorkspace(owner, `Tenant ${Date.now()}`);
  const admin = await createVerifiedUser({ tag: "root", name: "Root Admin" });
  await promoteSuperadmin(admin);

  // Anyone else gets "not found".
  const tenant = await browser.newContext();
  await signIn(tenant, owner);
  const tenantPage = await tenant.newPage();
  await tenantPage.goto("/admin");
  await expect(tenantPage.getByRole("heading", { level: 1 })).toContainText(/not found/i);

  const context = await browser.newContext();
  await signIn(context, admin);
  const page = await context.newPage();
  await page.goto("/account");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Instance administration" }).click();
  await expect(
    page.getByRole("heading", { name: "Instance administration", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Runs, 30 days")).toBeVisible();

  // Suspend, then restore, a workspace.
  await page.getByRole("searchbox", { name: "Search by name or slug" }).fill(workspace.name);
  const row = page.getByRole("listitem").filter({ hasText: workspace.name });
  await row.getByRole("button", { name: "Suspend" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByText(`${workspace.name} suspended`)).toBeVisible();
  await expect(row.getByText("Suspended", { exact: true })).toBeVisible();
  await tenantPage.goto(`/w/${workspace.slug}/overview`);
  await expect(tenantPage.getByText("Workspace suspended.")).toBeVisible();
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(`${workspace.name} restored`)).toBeVisible();

  // Disable an account: it is signed out everywhere.
  await page.getByRole("link", { name: "Users" }).click();
  await page.getByRole("searchbox", { name: "Search by e-mail or name" }).fill(owner.email);
  const user = page.getByRole("listitem").filter({ hasText: owner.email });
  await user.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disable" }).click();
  await expect(user.getByText("Disabled", { exact: true })).toBeVisible();
  await tenantPage.reload();
  await expect(tenantPage).toHaveURL(/\/login/);
  await user.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText(`${owner.email} enabled`)).toBeVisible();

  // Everything above is in the instance audit log.
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByText("admin.workspace_suspended").first()).toBeVisible();
  await expect(page.getByText("admin.user_disabled").first()).toBeVisible();
  await context.close();
  await tenant.close();
});
