import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, expectNoHorizontalOverflow } from "./support/a11y";
import {
  addMember,
  createAgent,
  createApiKey,
  createAutomation,
  createBuiltinTool,
  createConnection,
  createScriptedProvider,
  createSuite,
  createWorkflow,
  importCases,
  createVerifiedUser,
  createWorkspace,
  launchExecution,
  publishWorkflow,
  runAutomation,
  signIn,
  startRun,
  startWorkflowRun,
  updateAgent,
  waitForExecution,
  waitForRun,
  waitForWorkflowRun,
  type SeededUser,
  type SeededWorkspace,
} from "./support/api";

/**
 * Every screen, at the width of the running project (desktop, tablet, mobile) and in both
 * themes: no serious or critical axe violation (WCAG 2.2 AA) and no sideways scrolling.
 */
type Ids = {
  tool: string;
  agent: string;
  succeeded: string;
  failed: string;
  suite: string;
  runA: string;
  runB: string;
  workflow: string;
  workflowRun: string;
  webhook: string;
};
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
  { name: "evaluations", path: (w) => `/w/${w.slug}/evaluations`, ready: "Evaluations" },
  {
    name: "suite",
    path: (w, ids) => `/w/${w.slug}/evaluations/suites/${ids.suite}`,
    ready: "Answers",
  },
  {
    name: "run",
    path: (w, ids) => `/w/${w.slug}/evaluations/runs/${ids.runB}`,
    ready: "After",
  },
  {
    name: "compare",
    path: (w, ids) => `/w/${w.slug}/evaluations/compare?base=${ids.runA}&candidate=${ids.runB}`,
    ready: "Comparison",
  },
  { name: "workflows", path: (w) => `/w/${w.slug}/workflows`, ready: "Workflows" },
  {
    name: "workflow",
    path: (w, ids) => `/w/${w.slug}/workflows/${ids.workflow}`,
    ready: "Ticket routing",
  },
  { name: "automations", path: (w) => `/w/${w.slug}/automations`, ready: "Automations" },
  {
    name: "automation",
    path: (w, ids) => `/w/${w.slug}/automations/${ids.webhook}`,
    ready: "Ticket created",
  },
  { name: "connectors", path: (w) => `/w/${w.slug}/connectors`, ready: "Connectors" },
  { name: "registry", path: (w) => `/w/${w.slug}/registry`, ready: "Registry" },
  {
    name: "workflow-run",
    path: (w, ids) => `/w/${w.slug}/workflows/runs/${ids.workflowRun}`,
    ready: "Ticket routing",
  },
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
  const suite = await createSuite(owner, workspace.id, { name: "Answers", agent_id: agent.id });
  await importCases(owner, suite.id, [
    { name: "Greeting", input: "hello", expected: "Echo: hello" },
    { name: "Thanks", input: "thanks", expected: "Echo: thanks" },
  ]);
  const runA = await startRun(owner, { suite_id: suite.id, agent_id: agent.id, label: "Before" });
  await waitForRun(owner, runA.id);
  await updateAgent(owner, agent.id, { instructions: "Be brief." });
  const runB = await startRun(owner, { suite_id: suite.id, agent_id: agent.id, label: "After" });
  await waitForRun(owner, runB.id);
  const workflow = await createWorkflow(owner, workspace.id, {
    name: "Ticket routing",
    description: "Answers, then escalates urgent tickets.",
    graph: {
      nodes: [
        { id: "input", type: "start", label: "Ticket", position: { x: 0, y: 0 } },
        {
          id: "answer",
          type: "agent",
          label: "Answer",
          agent_id: agent.id,
          position: { x: 0, y: 124 },
        },
        {
          id: "check",
          type: "condition",
          label: "Urgent?",
          value: "{{steps.answer.output}}",
          operand: "urgent",
          position: { x: 0, y: 248 },
        },
        {
          id: "escalate",
          type: "transform",
          label: "Escalate",
          template: "Escalated: {{steps.answer.output}}",
          position: { x: -140, y: 372 },
        },
        { id: "output", type: "end", label: "Reply", position: { x: 0, y: 496 } },
      ],
      edges: [
        { id: "a", source: "input", target: "answer" },
        { id: "b", source: "answer", target: "check" },
        { id: "c", source: "check", target: "escalate", branch: "true" },
        { id: "d", source: "escalate", target: "output" },
        { id: "e", source: "check", target: "output", branch: "false" },
      ],
    },
  });
  await publishWorkflow(owner, workflow.id, "First version");
  const workflowRun = await startWorkflowRun(owner, workflow.id, {
    input: "This is urgent: the export fails",
  });
  await waitForWorkflowRun(owner, workflowRun.id);
  await createAutomation(owner, workspace.id, {
    name: "Morning digest",
    kind: "schedule",
    target_type: "agent",
    agent_id: agent.id,
    cron: "0 9 * * 1-5",
    timezone: "Europe/Paris",
    input: "Summarise yesterday's tickets",
  });
  const webhook = await createAutomation(owner, workspace.id, {
    name: "Ticket created",
    kind: "webhook",
    target_type: "agent",
    agent_id: agent.id,
  });
  await runAutomation(owner, webhook.id);
  await createConnection(owner, workspace.id, {
    connector: "slack",
    name: "Support Slack",
    credentials: { webhook_url: "https://hooks.slack.com/services/T000/B000/abcdefabcdef" },
  });
  ids = {
    webhook: webhook.id,
    workflow: workflow.id,
    workflowRun: workflowRun.id,
    tool: tool.id,
    agent: agent.id,
    succeeded: succeeded.id,
    failed: failed.id,
    suite: suite.id,
    runA: runA.id,
    runB: runB.id,
  };
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

    // Signed-in screens in groups of five, so each test stays short and failures point at a group.
    for (let start = 0; start < SIGNED_IN.length; start += 5) {
      const group = SIGNED_IN.slice(start, start + 5);
      test(`signed-in screens: ${group.map((screen) => screen.name).join(", ")}`, async ({
        context,
        page,
      }) => {
        await signIn(context, owner);
        for (const screen of group) await audit(page, screen, `${screen.name} (${scheme})`);
      });
    }

    test("onboarding", async ({ context, page }) => {
      await signIn(context, newcomer);
      await page.goto("/onboarding");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectAccessible(page, `onboarding (${scheme})`);
      await expectNoHorizontalOverflow(page, `onboarding (${scheme})`);
    });
  });
}
