import { expect, test } from "@playwright/test";
import {
  createAgent,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  signIn,
  updateAgent,
} from "./support/api";

const JSON_ANSWER = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
};
const CASES = [
  { name: "Refund request", input: "I want a refund for order 12" },
  { name: "Invoice copy", input: "Send me an invoice copy" },
  { name: "Bug report", input: "The export button does nothing" },
].map((item) => ({ ...item, graders: [{ type: "json_schema", schema: JSON_ANSWER }] }));

test("compare two versions of an agent from the interface", async ({ browser }) => {
  // Phase 6 exit criterion: one suite, two versions, a case-by-case verdict — all in the UI.
  test.setTimeout(150_000);
  const owner = await createVerifiedUser({ tag: "evaluator" });
  const workspace = await createWorkspace(owner, "Evaluators");
  const provider = await createScriptedProvider(owner, workspace.id);
  const agent = await createAgent(owner, workspace.id, {
    name: "Helper",
    provider_id: provider.id,
  });
  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  const base = `/w/${workspace.slug}`;

  await page.goto(`${base}/evaluations`);
  await page.getByRole("button", { name: "New suite" }).first().click();
  await page.getByRole("dialog").getByRole("textbox", { name: /Name/ }).fill("JSON answers");
  await page.getByRole("button", { name: "Create suite" }).click();
  await expect(page.getByRole("heading", { name: "JSON answers", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Import" }).click();
  const editor = page.getByRole("dialog").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(JSON.stringify(CASES));
  await page.getByRole("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("3 cases imported")).toBeVisible();

  const runSuite = async () => {
    await page.getByRole("button", { name: "Run suite" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: /Agent/ }).click();
    await page.getByRole("option", { name: "Helper" }).click();
    await dialog.getByRole("button", { name: "Start run" }).click();
    await expect(page).toHaveURL(/\/evaluations\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 45_000 });
  };

  await runSuite(); // version 1: plain text answers fail the schema
  await expect(page.getByText("Failed 3")).toBeVisible();

  await updateAgent(owner, agent.id, { parameters: { response_format: "json" } }); // version 2
  await page.goto(`${base}/evaluations`);
  await page.getByRole("link", { name: /JSON answers/ }).click();
  await runSuite(); // version 2: JSON answers pass
  await expect(page.getByText("Passed 3")).toBeVisible();

  await page.getByRole("combobox", { name: "Compare with…" }).click();
  await page.getByRole("option").first().click();
  await page.getByRole("link", { name: "Compare" }).click();
  await expect(page.getByRole("status")).toHaveText("The candidate does better.");
  await expect(page.getByRole("button", { name: /Improved\s*3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Regressed\s*0/ })).toBeVisible();
  await context.close();
});
