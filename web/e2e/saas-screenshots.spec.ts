import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  addMember,
  createAgent,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  launchExecution,
  promoteSuperadmin,
  setBudget,
  signIn,
  waitForExecution,
} from "./support/api";

/**
 * Screens of the SaaS phase (billing, budgets, data, instance administration) at three widths ×
 * two themes, into e2e/screenshots/ for visual review.
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
} as const;
const THEMES = ["light", "dark"] as const;
const OUT = "e2e/screenshots";
const ONLY = process.env.SCREENS?.split(",");

type Screen = {
  name: string;
  path: string;
  ready: string;
  prepare?: (page: Page) => Promise<void>;
};

test("capture SaaS screens", async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const owner = await createVerifiedUser({ tag: "saas", name: "Ada Lovelace" });
  const workspace = await createWorkspace(owner, "Acme Support");
  const member = await createVerifiedUser({ tag: "saas-member", name: "Mary Somerville" });
  await addMember(owner, workspace, member, "member");
  const provider = await createScriptedProvider(owner, workspace.id);
  const agent = await createAgent(owner, workspace.id, {
    name: "Support triage",
    provider_id: provider.id,
  });
  await waitForExecution(owner, (await launchExecution(owner, agent.id, "hello")).id);
  await setBudget(owner, workspace.id, {
    monthly_limit: "250.00",
    thresholds: [50, 80, 100],
    hard_stop: true,
  });
  await promoteSuperadmin(owner);
  const base = `/w/${workspace.slug}`;

  const screens: Screen[] = [
    { name: "settings-billing", path: `${base}/settings/billing`, ready: "Workspace settings" },
    { name: "settings-data", path: `${base}/settings/data`, ready: "Workspace settings" },
    { name: "usage-budget", path: `${base}/usage`, ready: "Usage" },
    {
      name: "budget-dialog",
      path: `${base}/usage`,
      ready: "Usage",
      prepare: async (page) => {
        await page.getByRole("button", { name: "Edit" }).click();
        await page.getByRole("dialog").waitFor();
      },
    },
    { name: "admin-workspaces", path: "/admin/workspaces", ready: "Instance administration" },
    { name: "admin-users", path: "/admin/users", ready: "Instance administration" },
    { name: "admin-audit", path: "/admin/audit", ready: "Instance administration" },
  ];

  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport, colorScheme: theme, locale: "en-US" });
      await signIn(context, owner);
      const page = await context.newPage();
      for (const screen of screens) {
        if (ONLY && !ONLY.includes(screen.name)) continue;
        await page.goto(screen.path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(screen.ready);
        if (screen.prepare) await screen.prepare(page);
        await page.waitForTimeout(1600);
        await page.screenshot({
          path: `${OUT}/${screen.name}--${viewportName}-${theme}.png`,
          fullPage: true,
        });
      }
      await context.close();
    }
  }
});
