import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createAgent,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  signIn,
} from "./support/api";

function signed(secret: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "Gouvra-Signature": `t=${timestamp},v1=${digest}`,
    },
  };
}

test("schedule a task, receive a signed webhook, connect a service", async ({
  browser,
  request,
}) => {
  // Phase 8 exit criterion: a scheduled task and a signed webhook, from the interface.
  test.setTimeout(150_000);
  const owner = await createVerifiedUser({ tag: "automator" });
  const workspace = await createWorkspace(owner, "Automators");
  const provider = await createScriptedProvider(owner, workspace.id);
  await createAgent(owner, workspace.id, { name: "Digest agent", provider_id: provider.id });
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  const base = `/w/${workspace.slug}`;

  // A schedule on weekdays at 09:00, then started at once with "Run now".
  await page.goto(`${base}/automations`);
  await page.getByRole("button", { name: "New schedule" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Name/ }).fill("Morning digest");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Digest agent" }).click();
  await dialog.getByRole("button", { name: "Weekdays at 09:00" }).click();
  await expect(dialog.getByText("At 09:00, Monday through Friday")).toBeVisible();
  await dialog.getByPlaceholder("What should each run work on?").fill("Summarise yesterday");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Morning digest", level: 1 })).toBeVisible();
  await expect(page.getByText("At 09:00, Monday through Friday")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next runs" })).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Run started")).toBeVisible();
  const startedRow = page.getByRole("listitem").filter({ hasText: "Run now" }).first();
  await expect(startedRow.getByText("Started", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(startedRow.getByRole("link", { name: /Open the run/ })).toBeVisible();

  // A webhook: its secret is shown once; a signed delivery starts a run, a forged one is refused.
  await page.goto(`${base}/automations`);
  await page.getByRole("button", { name: "New webhook" }).first().click();
  const hookDialog = page.getByRole("dialog");
  await hookDialog.getByRole("textbox", { name: /Name/ }).fill("Ticket created");
  await hookDialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Digest agent" }).click();
  await hookDialog
    .getByRole("textbox", { name: /Input template/ })
    .fill("New ticket: {{input.title}}");
  await hookDialog.getByRole("button", { name: "Create", exact: true }).click();
  const secretDialog = page.getByRole("dialog", { name: "Your webhook is ready" });
  await expect(secretDialog).toBeVisible();
  const codes = secretDialog.locator("code");
  const secret = (await codes.nth(0).textContent()) ?? "";
  const url = (await codes.nth(1).textContent()) ?? "";
  expect(secret).toMatch(/^gvwhsec_/);
  expect(url).toContain("/api/v1/hooks/");
  await secretDialog.getByRole("button", { name: "I have copied it" }).click();
  await expect(page.getByRole("heading", { name: "Ticket created", level: 1 })).toBeVisible();
  await expect(page.getByText("No delivery yet.")).toBeVisible();

  const delivery = signed(secret, { title: "Refund for order 12" });
  const accepted = await request.post(url, { data: delivery.body, headers: delivery.headers });
  expect(accepted.status()).toBe(202);
  const replay = await request.post(url, { data: delivery.body, headers: delivery.headers });
  expect(replay.status()).toBe(200);
  const replayed = (await replay.json()) as { duplicate: boolean };
  expect(replayed.duplicate).toBe(true);
  const forged = signed("not-the-secret", { title: "Forged" });
  expect((await request.post(url, { data: forged.body, headers: forged.headers })).status()).toBe(
    401,
  );

  const deliveries = page.getByRole("listitem").filter({ hasText: "Webhook" });
  await expect(deliveries.filter({ hasText: "Started" })).toHaveCount(1, { timeout: 15_000 });
  await expect(deliveries.filter({ hasText: "Refused" })).toHaveCount(1);
  await expect(page.getByText("The signature does not match the body.")).toBeVisible();

  // A Slack connection: its operation becomes a tool, shown in the registry.
  await page.goto(`${base}/connectors`);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Slack" })
    .getByRole("button", { name: "Connect" })
    .click();
  const connect = page.getByRole("dialog");
  await connect.getByRole("textbox", { name: /Name/ }).fill("Support Slack");
  await connect
    .getByLabel(/Incoming webhook URL/)
    .fill("https://hooks.slack.com/services/T000/B000/abcdefabcdef");
  await connect.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("“Support Slack” connected: 1 tool added")).toBeVisible();
  await expect(page.getByText("support_slack_post_message")).toBeVisible();
  await expect(page.getByText("Not verified yet")).toBeVisible();

  await page.goto(`${base}/registry`);
  await expect(page.getByRole("heading", { name: "Registry", level: 1 })).toBeVisible();
  await expect(page.getByText("gouvra-test-1").first()).toBeVisible();
  await page.getByRole("tab", { name: /Tools/ }).click();
  await expect(page.getByText("Support Slack — Post a message")).toBeVisible();
  await context.close();
});
