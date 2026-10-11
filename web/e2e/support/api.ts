import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";
import { API_URL, BASE_URL, DEFAULT_PASSWORD, uniqueEmail } from "./env";
import { tokenOf, waitForLink } from "./mailpit";

/**
 * Test data through the API itself (no database access): fast and realistic.
 * Requests go straight to the API with a random client address so the per-IP rate limits that
 * protect sign-up and e-mail links aren't shared by the whole suite. The local stack trusts one
 * proxy hop, so this only works against the development API — never against production.
 */
type Cookies = Map<string, string>;

export type SeededUser = {
  email: string;
  password: string;
  name: string;
  cookies: Cookies;
};

export type SeededWorkspace = { id: string; name: string; slug: string };

function randomIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 2;
  return `10.${n()}.${n()}.${n()}`;
}

async function call<T>(
  method: string,
  path: string,
  { body, cookies }: { body?: unknown; cookies?: Cookies } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Forwarded-For": randomIp(),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookies?.size) {
    headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const csrf = cookies.get("__Host-gv_csrf") ?? cookies.get("gv_csrf");
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (cookies) {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "" || /max-age=0/i.test(header)) cookies.delete(name);
      else cookies.set(name, value);
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Register through the API, confirm the address from the real e-mail, keep the session. */
export async function createVerifiedUser(
  options: { name?: string; password?: string; locale?: "en" | "fr"; tag?: string } = {},
): Promise<SeededUser> {
  const email = uniqueEmail(options.tag);
  const password = options.password ?? DEFAULT_PASSWORD;
  const name = options.name ?? "Ada Lovelace";
  const since = Date.now();
  await call("POST", "/auth/register", {
    body: {
      email,
      password,
      display_name: name,
      locale: options.locale ?? "en",
      accept_terms: true,
    },
  });
  const link = await waitForLink(email, "/verify-email", { since });
  const cookies: Cookies = new Map();
  await call("POST", "/auth/verify-email", { body: { token: tokenOf(link) }, cookies });
  return { email, password, name, cookies };
}

export async function createWorkspace(user: SeededUser, name: string): Promise<SeededWorkspace> {
  return call<SeededWorkspace>("POST", "/workspaces", { body: { name }, cookies: user.cookies });
}

export async function invite(
  owner: SeededUser,
  workspaceId: string,
  email: string,
  role: "admin" | "member" | "viewer" = "member",
): Promise<void> {
  await call("POST", `/workspaces/${workspaceId}/invitations`, {
    body: { email, role },
    cookies: owner.cookies,
  });
}

/** Invite `member` into the workspace and accept with their session (real e-mail link). */
export async function addMember(
  owner: SeededUser,
  workspace: SeededWorkspace,
  member: SeededUser,
  role: "admin" | "member" | "viewer" = "member",
): Promise<void> {
  const since = Date.now();
  await invite(owner, workspace.id, member.email, role);
  const link = await waitForLink(member.email, "/invite", { since });
  await call("POST", "/invitations/accept", {
    body: { token: tokenOf(link) },
    cookies: member.cookies,
  });
}

export async function createApiKey(owner: SeededUser, workspaceId: string, name: string) {
  return call<{ id: string; key: string; prefix: string }>(
    "POST",
    `/workspaces/${workspaceId}/api-keys`,
    { body: { name, role: "viewer", expires_in_days: 30 }, cookies: owner.cookies },
  );
}

/** Open a browser context already signed in as `user` (cookies from the API session). */
export async function signIn(context: BrowserContext, user: SeededUser): Promise<void> {
  const { hostname } = new URL(BASE_URL);
  await context.addCookies(
    [...user.cookies].map(([name, value]) => ({
      name,
      value,
      domain: hostname,
      path: "/",
      secure: name.startsWith("__Host-"),
      httpOnly: !name.endsWith("csrf"),
      sameSite: "Lax" as const,
    })),
  );
}

// ---------------------------------------------------------------- build & operate data

export type SeededProvider = { id: string; name: string };
export type SeededTool = { id: string; name: string; display_name: string };
export type SeededAgent = { id: string; name: string };
export type SeededExecution = { id: string; status: string };

/** The offline scripted provider: deterministic, free, no network. */
export async function createScriptedProvider(
  owner: SeededUser,
  workspaceId: string,
  name = "Scripted (offline)",
) {
  const provider = await call<SeededProvider>("POST", `/workspaces/${workspaceId}/providers`, {
    body: { name, kind: "test", default_model: "gouvra-test-1" },
    cookies: owner.cookies,
  });
  await call("POST", `/providers/${provider.id}/test`, { cookies: owner.cookies });
  return provider;
}

export async function createBuiltinTool(owner: SeededUser, workspaceId: string, key: string) {
  return call<SeededTool>("POST", `/workspaces/${workspaceId}/tools`, {
    body: { kind: "builtin", builtin_key: key },
    cookies: owner.cookies,
  });
}

export async function createAgent(
  owner: SeededUser,
  workspaceId: string,
  body: {
    name: string;
    provider_id: string;
    tool_ids?: string[];
    instructions?: string;
    description?: string;
  },
) {
  return call<SeededAgent>("POST", `/workspaces/${workspaceId}/agents`, {
    body: { model: "gouvra-test-1", instructions: "You are a helpful test agent.", ...body },
    cookies: owner.cookies,
  });
}

export async function launchExecution(owner: SeededUser, agentId: string, input: string) {
  return call<SeededExecution>("POST", `/agents/${agentId}/executions`, {
    body: { input },
    cookies: owner.cookies,
  });
}

/** Wait until the worker has finished the execution (the stack's real worker runs it). */
export async function waitForExecution(owner: SeededUser, executionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const execution = await call<SeededExecution>("GET", `/executions/${executionId}`, {
      cookies: owner.cookies,
    });
    if (!["queued", "running"].includes(execution.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Execution ${executionId} did not finish within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------- evaluations

export type SeededSuite = { id: string; name: string };
export type SeededRun = { id: string; status: string; summary: { pass_rate: number | null } };

export async function updateAgent(
  owner: SeededUser,
  agentId: string,
  body: Record<string, unknown>,
) {
  return call<SeededAgent>("PATCH", `/agents/${agentId}`, { body, cookies: owner.cookies });
}

export async function createSuite(
  owner: SeededUser,
  workspaceId: string,
  body: Record<string, unknown>,
) {
  return call<SeededSuite>("POST", `/workspaces/${workspaceId}/evaluations/suites`, {
    body,
    cookies: owner.cookies,
  });
}

export async function importCases(
  owner: SeededUser,
  suiteId: string,
  cases: Record<string, unknown>[],
) {
  return call<unknown[]>("POST", `/evaluations/suites/${suiteId}/cases/import`, {
    body: { cases },
    cookies: owner.cookies,
  });
}

export async function startRun(owner: SeededUser, body: Record<string, unknown>) {
  return call<SeededRun>("POST", "/evaluations/runs", { body, cookies: owner.cookies });
}

/** Wait until the worker has run and graded every case. */
export async function waitForRun(owner: SeededUser, runId: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await call<SeededRun>("GET", `/evaluations/runs/${runId}`, {
      cookies: owner.cookies,
    });
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs} ms`);
}

type SeededWorkflow = { id: string; name: string };
type SeededWorkflowRun = { id: string; status: string };

export async function createWorkflow(
  owner: SeededUser,
  workspaceId: string,
  body: Record<string, unknown>,
) {
  return call<SeededWorkflow>("POST", `/workspaces/${workspaceId}/workflows`, {
    body,
    cookies: owner.cookies,
  });
}

export async function publishWorkflow(owner: SeededUser, workflowId: string, note?: string) {
  return call<unknown>("POST", `/workflows/${workflowId}/publish`, {
    body: { note: note ?? null },
    cookies: owner.cookies,
  });
}

export async function startWorkflowRun(
  owner: SeededUser,
  workflowId: string,
  body: Record<string, unknown>,
) {
  return call<SeededWorkflowRun>("POST", `/workflows/${workflowId}/runs`, {
    body,
    cookies: owner.cookies,
  });
}

/** Wait until every step of a workflow run has settled. */
export async function waitForWorkflowRun(owner: SeededUser, runId: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await call<SeededWorkflowRun>("GET", `/workflow-runs/${runId}`, {
      cookies: owner.cookies,
    });
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Workflow run ${runId} did not finish within ${timeoutMs} ms`);
}

type SeededAutomation = {
  id: string;
  name: string;
  secret: string | null;
  hook_url: string | null;
};

export async function createAutomation(
  owner: SeededUser,
  workspaceId: string,
  body: Record<string, unknown>,
) {
  return call<SeededAutomation>("POST", `/workspaces/${workspaceId}/automations`, {
    body,
    cookies: owner.cookies,
  });
}

export async function runAutomation(owner: SeededUser, automationId: string) {
  return call<unknown>("POST", `/automations/${automationId}/run`, {
    body: { input: { event: "test" } },
    cookies: owner.cookies,
  });
}

export async function createConnection(
  owner: SeededUser,
  workspaceId: string,
  body: Record<string, unknown>,
) {
  return call<{ id: string }>("POST", `/workspaces/${workspaceId}/connections`, {
    body,
    cookies: owner.cookies,
  });
}

// ---------------------------------------------------------------- billing & administration

export type SeededBilling = { provider: string; test_mode: boolean; plan: { key: string } };

export async function billingOf(owner: SeededUser, workspaceId: string) {
  return call<SeededBilling>("GET", `/workspaces/${workspaceId}/billing`, {
    cookies: owner.cookies,
  });
}

export async function setBudget(
  owner: SeededUser,
  workspaceId: string,
  body: Record<string, unknown>,
) {
  return call("PUT", `/workspaces/${workspaceId}/budget`, { body, cookies: owner.cookies });
}

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Instance administration is only granted from the command line, like on a real install.
 * Asynchronous on purpose: blocking the event loop for seconds lets pooled keep-alive sockets go
 * stale, and the next request on one fails with "other side closed".
 */
export async function promoteSuperadmin(user: SeededUser): Promise<void> {
  await promisify(execFile)(
    "docker",
    ["compose", "exec", "-T", "api", "gouvra", "create-superadmin", user.email],
    { cwd: REPO_ROOT },
  );
}
