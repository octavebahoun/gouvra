import { expect, test } from "@playwright/test";
import {
  createAgent,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  signIn,
} from "./support/api";

test("build a multi-step workflow and follow its run live", async ({ browser }) => {
  // Phase 7 exit criterion: a multi-step workflow runs, and its run is visualised live.
  test.setTimeout(150_000);
  const owner = await createVerifiedUser({ tag: "orchestrator" });
  const workspace = await createWorkspace(owner, "Orchestrators");
  const provider = await createScriptedProvider(owner, workspace.id);
  await createAgent(owner, workspace.id, { name: "Support agent", provider_id: provider.id });
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  const base = `/w/${workspace.slug}`;

  // Create it from the "Decision" template: input → agent → condition → escalation → output.
  await page.goto(`${base}/workflows`);
  await page.getByRole("button", { name: "New workflow" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Name/ }).fill("Support triage");
  await dialog.getByRole("radio", { name: /Decision/ }).click();
  await dialog.getByRole("button", { name: "Create workflow" }).click();
  await expect(page.getByRole("heading", { name: "Support triage", level: 1 })).toBeVisible();
  for (const id of ["input", "answer", "check", "escalation", "output"]) {
    await expect(page.getByTestId(`rf__node-${id}`)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Ready to run" })).toBeVisible();

  // Edit the agent step in the inspector: slow it down so the run can be watched.
  await page.getByTestId("rf__node-answer").click();
  const inspector = page.getByRole("complementary", { name: "Properties" });
  await expect(inspector.getByRole("heading", { name: "Answer" })).toBeVisible();
  const input = inspector.getByRole("textbox", { name: "Input" });
  await input.fill("[sleep:2500] {{input}}");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Add a step from the palette, then undo it.
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: /Transform/ }).click();
  await expect(page.getByTestId("rf__node-transform")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("rf__node-transform")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Test the draft: the run page shows each step's state as it happens.
  await page.getByRole("button", { name: "Test draft" }).click();
  const runDialog = page.getByRole("dialog");
  await runDialog.getByRole("textbox", { name: "Input" }).fill("This is urgent: my order is late");
  await runDialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/workflows\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Live")).toBeVisible({ timeout: 15_000 });
  const answerStep = page.getByRole("button", { name: /Answer/ }).filter({ hasText: "Running" });
  await expect(answerStep).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("rf__node-answer")).toHaveAttribute("aria-label", /Running/);

  await expect(page.getByText("Succeeded").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("5/5 steps").first()).toBeVisible();
  await expect(page.getByText("Escalate: Echo: This is urgent: my order is late")).toBeVisible();
  await expect(page.getByTestId("rf__node-check")).toHaveAttribute("aria-label", /Done/);

  // The condition's step details: the branch it took, what it received and passed on.
  await page.getByRole("button", { name: /Urgent\?/ }).click();
  await expect(page.getByText("Took “Yes”")).toBeVisible();
  await page.getByRole("button", { name: "All steps" }).click();
  await page.getByRole("button", { name: /Answer/ }).click();
  await expect(page.getByRole("link", { name: "Open the agent's trace" })).toBeVisible();

  // Publish, then the published version runs from the editor.
  await page.getByRole("link", { name: "Open editor" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Note" }).fill("First version");
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Version 1 published")).toBeVisible();
  await expect(page.getByText("v1").first()).toBeVisible();
  await page.getByRole("tab", { name: /Versions/ }).click();
  await expect(page.getByText("First version")).toBeVisible();
  await context.close();
});
