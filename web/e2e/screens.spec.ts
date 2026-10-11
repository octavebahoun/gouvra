import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, expectNoHorizontalOverflow } from "./support/a11y";
import {
  addMember,
  createAgent,
  createApiKey,
  createBuiltinTool,
  createScriptedProvider,
  createVerifiedUser,
  createWorkspace,
  launchExecution,
  signIn,
  waitForExecution,
  type SeededUser,
  type SeededWorkspace,
} from "./support/api";

/**
 * Every screen, at the width of the running project (desktop, tablet, mobile) and in both
 * themes: no serious or critical axe violation (WCAG 2.2 AA) and no sideways scrolling.
 */
type Ids = { tool: string; agent: string; succeeded: string; failed: string };
type Screen = {
  name: string;
  path: (w: SeededWorkspace, ids: Ids) => string;
  ready: string | RegExp;
};

const PUBLIC: Screen[] = [
  { name: "landing", path: () => "/", ready: /agents/i },
  { name: "login", path: () => "/login", ready: "Sign in to Gouvra" },
  { name: "register", path: () => "/register", ready: "Create your account" },
  { name: "forgot-password", path: () => "/forgot-password", ready: "Reset your password" },
  {
    name: "verify-email-request",
    path: () => "/verify-email",
    ready: "Get a new confirmation link",
  },
  {
    name: "reset-password-missing",
    path: () => "/reset-password",
    ready: "Open the link from your e-mail",
  },
  { name: "not-found", path: () => "/this/page/does/not/exist", ready: /not found|doesn.t exist/i },
];

const SIGNED_IN: Screen[] = [
  { name: "overview", path: (w) => `/w/${w.slug}/overview`, ready: "Overview" },
  {
    name: "settings-general",
    path: (w) => `/w/${w.slug}/settings/general`,
    ready: "Workspace settings",
  },
  {
    name: "settings-members",
    path: (w) => `/w/${w.slug}/settings/members`,
    ready: "Workspace settings",
  },
  {
    name: "settings-api-keys",
    path: (w) => `/w/${w.slug}/settings/api-keys`,
    ready: "Workspace settings",
  },
  {
    name: "settings-audit",
    path: (w) => `/w/${w.slug}/settings/audit`,
    ready: "Workspace settings",
  },
  { name: "account", path: () => "/account", ready: "Profile & preferences" },
  { name: "providers", path: (w) => `/w/${w.slug}/providers`, ready: "Providers" },
  { name: "tools", path: (w) => `/w/${w.slug}/tools`, ready: "Tools" },
  { name: "tool", path: (w, ids) => `/w/${w.slug}/tools/${ids.tool}`, ready: "Calculator" },
  { name: "agents", path: (w) => `/w/${w.slug}/agents`, ready: "Agents" },
  { name: "agent", path: (w, ids) => `/w/${w.slug}/agents/${ids.agent}`, ready: "Support triage" },
  { name: "agent-new", path: (w) => `/w/${w.slug}/agents/new`, ready: "New agent" },
  { name: "executions", path: (w) => `/w/${w.slug}/executions`, ready: "Executions" },
  {
    name: "execution-succeeded",
    path: (w, ids) => `/w/${w.slug}/executions/${ids.succeeded}`,
    ready: "Support triage",
  },
  {
    name: "execution-failed",
    path: (w, ids) => `/w/${w.slug}/executions/${ids.failed}`,
    ready: "Support triage",
  },
  { name: "usage", path: (w) => `/w/${w.slug}/usage`, ready: "Usage" },
];

let owner: SeededUser;
let workspace: SeededWorkspace;
let newcomer: SeededUser;
let ids: Ids;

test.beforeAll(async () => {
  owner = await createVerifiedUser({ tag: "screens", name: "Ada Lovelace" });
  workspace = await createWorkspace(owner, "Screens Studio");
  const member = await createVerifiedUser({ tag: "screens-member", name: "Mary Somerville" });
  await addMember(owner, workspace, member, "member");
  await createApiKey(owner, workspace.id, "CI pipeline");
  newcomer = await createVerifiedUser({ tag: "screens-new", name: "Grace Hopper" });
  const provider = await createScriptedProvider(owner, workspace.id);
  const tool = await createBuiltinTool(owner, workspace.id, "calculator");
  const agent = await createAgent(owner, workspace.id, {
    name: "Support triage",
    description: "Classifies incoming tickets.",
    provider_id: provider.id,
    tool_ids: [tool.id],
  });
  const succeeded = await launchExecution(
    owner,
    agent.id,
    'Total? [tool:calculator {"expression": "2 * 49.99"}]',
  );
  const failed = await launchExecution(owner, agent.id, "Quota [fail:provider_rate_limited]");
  await waitForExecution(owner, succeeded.id);
  await waitForExecution(owner, failed.id);
  ids = { tool: tool.id, agent: agent.id, succeeded: succeeded.id, failed: failed.id };
});

async function audit(page: Page, screen: Screen, label: string): Promise<void> {
  await page.goto(screen.path(workspace, ids));
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(screen.ready);
  await expectAccessible(page, label);
  await expectNoHorizontalOverflow(page, label);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("public screens", async ({ page }) => {
      for (const screen of PUBLIC) await audit(page, screen, `${screen.name} (${scheme})`);
    });

    test("signed-in screens", async ({ context, page }) => {
      await signIn(context, owner);
      for (const screen of SIGNED_IN) await audit(page, screen, `${screen.name} (${scheme})`);
    });

    test("onboarding", async ({ context, page }) => {
      await signIn(context, newcomer);
      await page.goto("/onboarding");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectAccessible(page, `onboarding (${scheme})`);
      await expectNoHorizontalOverflow(page, `onboarding (${scheme})`);
    });
  });
}
