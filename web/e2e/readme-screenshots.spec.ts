import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { API_URL } from "./support/env";

/**
 * README images from the demo workspace (scripts/seed: realistic history, real DeepSeek runs).
 * Needs DEMO_PASSWORD in the environment; skipped otherwise. Writes to ../docs/images/.
 */
const OUT = "../docs/images";
const password = process.env.DEMO_PASSWORD;

test("capture README images", async ({ browser }) => {
  test.skip(!password, "DEMO_PASSWORD is not set");
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });

  const login = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:8080" },
    body: JSON.stringify({ email: "demo@gouvra.dev", password }),
  });
  expect(login.ok).toBe(true);
  const cookies = login.headers.getSetCookie().map((header) => {
    const [pair = ""] = header.split(";");
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1) };
  });
  const executions = (await (
    await fetch(`${API_URL}/api/v1/workspaces/${await workspaceId()}/executions?limit=100`, {
      headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    })
  ).json()) as {
    data: { id: string; status: string; model: string | null; agent: { name: string } | null }[];
  };
  const real = executions.data.find(
    (e) => e.model === "deepseek-flash" && e.status === "succeeded",
  );
  const failed = executions.data.find((e) => e.status === "failed");
  const auth = { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } };
  const demoId = await workspaceId();
  const flowRuns = (await (
    await fetch(`${API_URL}/api/v1/workspaces/${demoId}/workflow-runs?limit=10`, auth)
  ).json()) as { data: { id: string; status: string }[] };
  const flowRun = flowRuns.data.find((r) => r.status === "succeeded");
  const evalRuns = (await (
    await fetch(`${API_URL}/api/v1/workspaces/${demoId}/evaluations/runs?limit=10`, auth)
  ).json()) as { data: { id: string; label: string }[] };
  const baseline = evalRuns.data.find((r) => r.label === "Baseline");
  const candidate = evalRuns.data.find((r) => r.label === "Shorter instructions");

  async function workspaceId(): Promise<string> {
    const session = (await (
      await fetch(`${API_URL}/api/v1/auth/session`, {
        headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
      })
    ).json()) as { workspaces: { id: string; slug: string }[] };
    return session.workspaces.find((w) => w.slug === "demo")?.id ?? "";
  }

  const shots: {
    file: string;
    path: string;
    theme: "light" | "dark";
    width?: number;
    height?: number;
    prepare?: (p: Page) => Promise<void>;
  }[] = [
    { file: "landing.png", path: "/", theme: "light", height: 980 },
    { file: "overview.png", path: "/w/demo/overview", theme: "light" },
    {
      file: "execution-live-dark.png",
      path: `/w/demo/executions/${real?.id ?? ""}`,
      theme: "dark",
    },
    {
      file: "execution-failed.png",
      path: `/w/demo/executions/${failed?.id ?? ""}`,
      theme: "light",
    },
    { file: "agents.png", path: "/w/demo/agents", theme: "light" },
    { file: "usage-dark.png", path: "/w/demo/usage?period=30d", theme: "dark" },
    {
      file: "workflow-run.png",
      path: `/w/demo/workflows/runs/${flowRun?.id ?? ""}`,
      theme: "light",
    },
    {
      file: "evaluation-compare-dark.png",
      path: `/w/demo/evaluations/compare?base=${baseline?.id ?? ""}&candidate=${candidate?.id ?? ""}`,
      theme: "dark",
    },
    {
      file: "mobile-execution.png",
      path: `/w/demo/executions/${real?.id ?? ""}`,
      theme: "dark",
      width: 390,
      height: 844,
    },
  ];
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: shot.width ?? 1440, height: shot.height ?? 900 },
      colorScheme: shot.theme,
      deviceScaleFactor: 1,
      locale: "en-US",
    });
    const { hostname } = new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080");
    await context.addCookies(
      cookies.map((c) => ({
        ...c,
        domain: hostname,
        path: "/",
        secure: c.name.startsWith("__Host-"),
        httpOnly: !c.name.endsWith("csrf"),
        sameSite: "Lax" as const,
      })),
    );
    const page = await context.newPage();
    await page.goto(shot.path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForTimeout(shot.file === "landing.png" ? 4200 : 1800);
    await page.screenshot({ path: `${OUT}/${shot.file}` });
    await context.close();
  }
});
