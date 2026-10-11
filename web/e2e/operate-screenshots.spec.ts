import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  createAgent,
  createBuiltinTool,
  createScriptedProvider,
  createSuite,
  createVerifiedUser,
  createWorkspace,
  importCases,
  launchExecution,
  signIn,
  startRun,
  updateAgent,
  waitForExecution,
  waitForRun,
} from "./support/api";

/**
 * Screens of the build & operate phases (providers, tools, agents, executions, overview, usage)
 * at three widths × two themes, into e2e/screenshots/ for visual review. Data is real: the
 * stack's worker runs the executions with the offline scripted model.
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
} as const;
const THEMES = ["light", "dark"] as const;
const OUT = "e2e/screenshots";
const ONLY_VIEWPORTS = process.env.SCREEN_VIEWPORTS?.split(",");
const ONLY_THEMES = process.env.SCREEN_THEMES?.split(",");
const ONLY = process.env.SCREENS?.split(",");

test("capture build & operate screens", async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const owner = await createVerifiedUser({ tag: "operate", name: "Ada Lovelace" });
  const workspace = await createWorkspace(owner, "Acme Support");
  const provider = await createScriptedProvider(owner, workspace.id);
  const calculator = await createBuiltinTool(owner, workspace.id, "calculator");
  const clock = await createBuiltinTool(owner, workspace.id, "current_time");
  await createBuiltinTool(owner, workspace.id, "date_calc");
  const triage = await createAgent(owner, workspace.id, {
    name: "Support triage",
    description: "Classifies incoming tickets and drafts a first reply.",
    provider_id: provider.id,
    tool_ids: [calculator.id, clock.id],
    instructions:
      "You triage customer support tickets. Classify each ticket as billing, bug or question, then propose a one-line reply. Use the calculator for any arithmetic.",
  });
  await createAgent(owner, workspace.id, {
    name: "Cost estimator",
    description: "Answers questions about usage and spend with exact arithmetic.",
    provider_id: provider.id,
    tool_ids: [calculator.id],
  });
  const ok = await launchExecution(
    owner,
    triage.id,
    'Ticket #4821: "I was charged twice." Monthly total? [tool:calculator {"expression": "2 * 49.99"}] [think]',
  );
  const failed = await launchExecution(
    owner,
    triage.id,
    "Check the quota. [fail:provider_rate_limited]",
  );
  await launchExecution(owner, triage.id, "Summarise this release in one sentence.");
  await waitForExecution(owner, ok.id);
  await waitForExecution(owner, failed.id);

  // Evaluations: one suite run before and after switching the agent to JSON answers.
  const suite = await createSuite(owner, workspace.id, {
    name: "JSON answers",
    description: "Replies must be JSON objects with an answer field.",
    agent_id: triage.id,
    default_graders: [
      {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      },
    ],
  });
  await importCases(owner, suite.id, [
    { name: "Refund request", input: "I want a refund for order 12", tags: ["billing"] },
    { name: "Invoice copy", input: "Send me an invoice copy", tags: ["billing"] },
    { name: "Bug report", input: "The export button does nothing", tags: ["bug"] },
    { name: "Plan question", input: "Which plan includes SSO?", tags: ["question"] },
  ]);
  const before = await startRun(owner, {
    suite_id: suite.id,
    agent_id: triage.id,
    label: "Text answers",
  });
  await waitForRun(owner, before.id);
  await updateAgent(owner, triage.id, { parameters: { response_format: "json" } });
  const after = await startRun(owner, {
    suite_id: suite.id,
    agent_id: triage.id,
    label: "JSON mode",
  });
  await waitForRun(owner, after.id);

  const base = `/w/${workspace.slug}`;
  const screens: {
    name: string;
    path: string;
    ready: string | RegExp;
    prepare?: (page: Page) => Promise<void>;
  }[] = [
    { name: "overview-live", path: `${base}/overview`, ready: "Overview" },
    { name: "providers", path: `${base}/providers`, ready: "Providers" },
    {
      name: "provider-dialog",
      path: `${base}/providers`,
      ready: "Providers",
      prepare: async (page) => {
        await page.getByRole("button", { name: "Add provider" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      },
    },
    { name: "tools", path: `${base}/tools`, ready: "Tools" },
    { name: "tool-detail", path: `${base}/tools/${calculator.id}`, ready: /Calculator/i },
    { name: "agents", path: `${base}/agents`, ready: "Agents" },
    { name: "agent-detail", path: `${base}/agents/${triage.id}`, ready: "Support triage" },
    {
      name: "agent-editor",
      path: `${base}/agents/${triage.id}/edit`,
      ready: /Edit Support triage/,
    },
    {
      name: "launch-dialog",
      path: `${base}/agents/${triage.id}`,
      ready: "Support triage",
      prepare: async (page) => {
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      },
    },
    { name: "executions", path: `${base}/executions`, ready: "Executions" },
    { name: "execution-succeeded", path: `${base}/executions/${ok.id}`, ready: "Support triage" },
    { name: "execution-failed", path: `${base}/executions/${failed.id}`, ready: "Support triage" },
    { name: "usage", path: `${base}/usage`, ready: "Usage" },
    { name: "evaluations", path: `${base}/evaluations`, ready: "Evaluations" },
    { name: "suite", path: `${base}/evaluations/suites/${suite.id}`, ready: "JSON answers" },
    { name: "eval-run", path: `${base}/evaluations/runs/${after.id}`, ready: "JSON mode" },
    {
      name: "eval-compare",
      path: `${base}/evaluations/compare?base=${before.id}&candidate=${after.id}`,
      ready: "Comparison",
    },
  ];

  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    if (ONLY_VIEWPORTS && !ONLY_VIEWPORTS.includes(viewportName)) continue;
    for (const theme of THEMES) {
      if (ONLY_THEMES && !ONLY_THEMES.includes(theme)) continue;
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
