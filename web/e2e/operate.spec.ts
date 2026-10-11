import { expect, test } from "@playwright/test";
import {
  createAgent,
  createBuiltinTool,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  signIn,
} from "./support/api";

/**
 * Build & operate journeys through the real stack (API + worker): the scripted offline model
 * makes every run deterministic and free.
 */

test("connect a provider, build an agent and follow its execution live", async ({ browser }) => {
  // Phase 3 exit criterion, through the interface: one execution traced end to end.
  const owner = await createVerifiedUser({ tag: "builder" });
  const workspace = await createWorkspace(owner, "Builders");
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  const base = `/w/${workspace.slug}`;

  await page.goto(`${base}/providers`);
  await page.getByRole("button", { name: "Start offline" }).click();
  const providerDialog = page.getByRole("dialog");
  await expect(providerDialog.getByRole("radio", { name: /offline/i })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await providerDialog.getByRole("button", { name: "Add and test" }).click();
  await expect(page.getByText(/is connected/)).toBeVisible();
  await expect(page.getByText("Connected", { exact: false }).first()).toBeVisible();

  await page.goto(`${base}/tools`);
  await page.getByRole("button", { name: "Add a tool" }).click();
  await page.getByRole("button", { name: "Add Calculator" }).click();
  await expect(page.getByText("Calculator added")).toBeVisible();

  await page.goto(`${base}/agents/new`);
  await page.getByRole("textbox", { name: "Name (required)" }).fill("Accountant");
  await page
    .getByRole("textbox", { name: "Instructions" })
    .fill("Always use the calculator for arithmetic.");
  await page.getByRole("checkbox", { name: /Calculator/ }).check();
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByRole("heading", { name: "Accountant", level: 1 })).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .fill('How much is 1234 * 5678? [tool:calculator {"expression": "1234 * 5678"}] [sleep:1200]');
  await page.getByRole("dialog").getByRole("button", { name: "Run", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`${base}/executions/[0-9a-f-]{36}$`));
  // Live: the trace fills in while it runs, then the state settles.
  await expect(page.getByText("Tool call").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-status=succeeded]").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("7006652").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Output" })).toBeVisible();
  await context.close();
});

test("diagnose a failed execution from the interface", async ({ browser }) => {
  // Phase 4 exit criterion: the cause and the next action are on the execution page.
  const owner = await createVerifiedUser({ tag: "diagnose" });
  const workspace = await createWorkspace(owner, "Diagnose");
  const provider = await createScriptedProvider(owner, workspace.id);
  const agent = await createAgent(owner, workspace.id, {
    name: "Fragile",
    provider_id: provider.id,
  });
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  const base = `/w/${workspace.slug}`;

  await page.goto(`${base}/agents/${agent.id}`);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .fill("Check the quota [fail:provider_rate_limited]");
  await page.keyboard.press("Control+Enter");

  await expect(page.locator("[data-status=failed]").first()).toBeVisible({ timeout: 20_000 });
  const diagnosis = page.getByRole("region", { name: "The provider is limiting requests" });
  await expect(diagnosis).toBeVisible();
  await expect(diagnosis).toContainText("provider_rate_limited");
  await expect(diagnosis).toContainText("Retrying may work");
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();

  // The failure is also visible where people look first.
  await page.goto(`${base}/overview`);
  await expect(page.getByText("The provider is limiting requests")).toBeVisible();
  await page.goto(`${base}/executions?status=failed`);
  await expect(page.getByRole("link", { name: "Fragile" })).toBeVisible();
  await context.close();
});

test("tools are tested from the console before agents use them", async ({ browser }) => {
  const owner = await createVerifiedUser({ tag: "tools" });
  const workspace = await createWorkspace(owner, "Tooling");
  const calculator = await createBuiltinTool(owner, workspace.id, "calculator");
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  await page.goto(`/w/${workspace.slug}/tools/${calculator.id}`);
  await page.getByRole("tab", { name: "Test" }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/Succeeded in/)).toBeVisible();
  await context.close();
});
