import { mkdirSync } from "node:fs";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  addMember,
  createApiKey,
  createVerifiedUser,
  createWorkspace,
  invite,
  signIn,
  type SeededUser,
  type SeededWorkspace,
} from "./support/api";
import { uniqueEmail } from "./support/env";

/**
 * Captures every screen of the identity phase at desktop / tablet / mobile × light / dark into
 * e2e/screenshots/ (git-ignored) for visual review. States that need a one-time e-mail token or
 * a specific API answer (expired link, mismatch…) are reproduced by answering those requests
 * locally, so the run doesn't spend real tokens or hit the rate limits.
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const OUT = "e2e/screenshots";
const ONLY = process.env.SCREENS?.split(",");
const ONLY_VIEWPORTS = process.env.SCREEN_VIEWPORTS?.split(",") as ViewportName[] | undefined;
const ONLY_THEMES = process.env.SCREEN_THEMES?.split(",") as Theme[] | undefined;

type Fixture = {
  owner: SeededUser;
  workspace: SeededWorkspace;
  newcomer: SeededUser;
  unverified: SeededUser;
};

const FAKE_TOKEN = "screenshot-token-0123456789abcdef";

function problem(status: number, code: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({ status, code, title: code, request_id: "0199d2c48f1e7c3a" }),
  };
}

const preview = (status: string) => ({
  workspace_name: "Acme Platform",
  inviter_name: "Ada Lovelace",
  role: "member",
  email_hint: "g•••••@example.com",
  expires_at: new Date(Date.now() + 6 * 86400_000).toISOString(),
  status,
});

type Screen = {
  name: string;
  as?: "owner" | "newcomer" | "unverified" | "anonymous";
  path: (f: Fixture) => string;
  setup?: (page: Page, f: Fixture) => Promise<void>;
  /** Runs after the page loaded: open a dialog, submit a form… */
  act?: (page: Page, f: Fixture) => Promise<void>;
  viewports?: ViewportName[];
  /** Dialogs and drawers are captured as the viewport the person sees. */
  fullPage?: boolean;
};

const SCREENS: Screen[] = [
  { name: "login", path: () => "/login" },
  { name: "login-oauth-error", path: () => "/login?oauth_error=email_unverified" },
  {
    name: "login-invalid",
    path: () => "/login",
    act: async (page) => {
      await page.getByRole("textbox", { name: "E-mail" }).fill("nobody@example.com");
      await page.getByLabel("Password", { exact: true }).fill("wrong-password-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByText("Incorrect e-mail or password").waitFor();
    },
  },
  {
    name: "login-rate-limited",
    path: () => "/login",
    setup: async (page) => {
      await page.route("**/api/v1/auth/login", (route) =>
        route.fulfill({
          ...problem(429, "rate_limited"),
          body: JSON.stringify({ status: 429, code: "rate_limited", details: { retry_after: 54 } }),
        }),
      );
    },
    act: async (page) => {
      await page.getByRole("textbox", { name: "E-mail" }).fill("ada@example.com");
      await page.getByLabel("Password", { exact: true }).fill("whatever-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page
        .getByText(/Too many attempts/)
        .first()
        .waitFor();
    },
  },
  { name: "register", path: () => "/register" },
  {
    name: "register-errors",
    path: () => "/register",
    act: async (page) => {
      await page.getByLabel("Password", { exact: true }).fill("short");
      await page.getByRole("button", { name: "Create account" }).click();
    },
  },
  {
    name: "register-sent",
    path: () => "/register",
    setup: async (page) => {
      await page.route("**/api/v1/auth/register", (route) =>
        route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ status: "accepted", message: "ok" }),
        }),
      );
    },
    act: async (page) => {
      await page.getByLabel("Your name").fill("Grace Hopper");
      await page.getByRole("textbox", { name: "E-mail" }).fill("grace@example.com");
      await page.getByLabel("Password", { exact: true }).fill("Tidal-harbor-lantern-42");
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByRole("heading", { name: "Check your inbox" }).waitFor();
    },
  },
  { name: "forgot-password", path: () => "/forgot-password" },
  {
    name: "forgot-password-sent",
    path: () => "/forgot-password",
    setup: async (page) => {
      await page.route("**/api/v1/auth/password/forgot", (route) =>
        route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ status: "accepted", message: "ok" }),
        }),
      );
    },
    act: async (page) => {
      await page.getByRole("textbox", { name: "E-mail" }).fill("ada@example.com");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await page.getByRole("heading", { name: "Check your inbox" }).waitFor();
    },
  },
  { name: "reset-password", path: () => `/reset-password#token=${FAKE_TOKEN}` },
  { name: "reset-password-missing", path: () => "/reset-password" },
  {
    name: "reset-password-expired",
    path: () => `/reset-password#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/auth/password/reset", (route) =>
        route.fulfill(problem(410, "token_invalid")),
      );
    },
    act: async (page) => {
      await page.getByLabel("New password").fill("Tidal-harbor-lantern-42");
      await page.getByRole("button", { name: "Update password" }).click();
      await page.getByRole("heading", { name: "This reset link has expired" }).waitFor();
    },
  },
  {
    name: "verify-email-expired",
    path: () => `/verify-email#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/auth/verify-email", (route) =>
        route.fulfill(problem(410, "token_invalid")),
      );
    },
  },
  { name: "verify-email-request", path: () => "/verify-email" },
  { name: "verify-email-pending", as: "unverified", path: () => "/verify-email" },
  {
    name: "confirm-email-expired",
    path: () => `/confirm-email#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/auth/email/confirm", (route) =>
        route.fulfill(problem(410, "token_invalid")),
      );
    },
  },
  {
    name: "invite-signed-out",
    path: () => `/invite#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/invitations/preview", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(preview("pending")),
        }),
      );
    },
  },
  {
    name: "invite-signed-in",
    as: "newcomer",
    path: () => `/invite#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/invitations/preview", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(preview("pending")),
        }),
      );
    },
  },
  {
    name: "invite-mismatch",
    as: "newcomer",
    path: () => `/invite#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/invitations/preview", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(preview("pending")),
        }),
      );
      await page.route("**/api/v1/invitations/accept", (route) =>
        route.fulfill(problem(403, "invitation_email_mismatch")),
      );
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Accept and join" }).click();
      await page.getByRole("heading", { name: "This invitation is for another address" }).waitFor();
    },
  },
  {
    name: "invite-expired",
    path: () => `/invite#token=${FAKE_TOKEN}`,
    setup: async (page) => {
      await page.route("**/api/v1/invitations/preview", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(preview("expired")),
        }),
      );
    },
  },
  { name: "onboarding-welcome", as: "newcomer", path: () => "/onboarding" },
  { name: "onboarding-workspace", as: "newcomer", path: () => "/onboarding?step=workspace" },
  {
    name: "onboarding-workspace-custom-url",
    as: "newcomer",
    path: () => "/onboarding?step=workspace",
    act: async (page) => {
      await page.getByLabel("Workspace name").fill("Orbital Research");
      await page.getByRole("button", { name: "Customize URL" }).click();
    },
  },
  {
    name: "onboarding-invite",
    as: "owner",
    path: (f) => `/onboarding?step=invite&w=${f.workspace.slug}`,
  },
  {
    name: "onboarding-checklist",
    as: "owner",
    path: (f) => `/onboarding?step=checklist&w=${f.workspace.slug}`,
  },
  { name: "overview", as: "owner", path: (f) => `/w/${f.workspace.slug}/overview` },
  { name: "interim-agents", as: "owner", path: (f) => `/w/${f.workspace.slug}/agents` },
  { name: "interim-usage", as: "owner", path: (f) => `/w/${f.workspace.slug}/usage` },
  { name: "settings-general", as: "owner", path: (f) => `/w/${f.workspace.slug}/settings/general` },
  { name: "settings-members", as: "owner", path: (f) => `/w/${f.workspace.slug}/settings/members` },
  {
    name: "settings-api-keys",
    as: "owner",
    path: (f) => `/w/${f.workspace.slug}/settings/api-keys`,
  },
  {
    name: "settings-api-key-reveal",
    fullPage: false,
    as: "owner",
    path: (f) => `/w/${f.workspace.slug}/settings/api-keys`,
    act: async (page) => {
      await page.getByRole("button", { name: "Create a key" }).first().click();
      await page.getByLabel("Name").fill("Screenshot key");
      await page.getByRole("button", { name: "Create key" }).click();
      await page.getByRole("heading", { name: "Copy your new key" }).waitFor();
    },
  },
  {
    name: "settings-delete-dialog",
    fullPage: false,
    as: "owner",
    path: (f) => `/w/${f.workspace.slug}/settings/general`,
    act: async (page) => {
      await page.getByRole("button", { name: "Delete workspace…" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "settings-audit", as: "owner", path: (f) => `/w/${f.workspace.slug}/settings/audit` },
  {
    name: "settings-member-view",
    as: "newcomer",
    path: (f) => `/w/${f.workspace.slug}/settings/members`,
  },
  { name: "account", as: "owner", path: () => "/account" },
  {
    name: "create-workspace-dialog",
    fullPage: false,
    as: "owner",
    path: (f) => `/w/${f.workspace.slug}/overview`,
    viewports: ["desktop", "tablet"],
    act: async (page) => {
      await page.getByRole("button", { name: /Current workspace/ }).click();
      await page.getByRole("menuitem", { name: "Create a workspace" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "mobile-navigation",
    fullPage: false,
    as: "owner",
    path: (f) => `/w/${f.workspace.slug}/overview`,
    viewports: ["mobile"],
    act: async (page) => {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "workspace-not-found", as: "owner", path: () => "/w/not-a-member-here/overview" },
];

async function seed(): Promise<Fixture> {
  const owner = await createVerifiedUser({ name: "Ada Lovelace", tag: "owner" });
  const workspace = await createWorkspace(owner, "Acme Platform");
  await createWorkspace(owner, "Research Lab");
  const newcomer = await createVerifiedUser({ name: "Grace Hopper", tag: "member" });
  await addMember(owner, workspace, newcomer, "member");
  await invite(owner, workspace.id, uniqueEmail("pending"), "viewer");
  await createApiKey(owner, workspace.id, "CI pipeline");
  // A signed-in account that hasn't confirmed its address yet.
  const unverified = await createUnverified();
  return { owner, workspace, newcomer, unverified };
}

async function createUnverified(): Promise<SeededUser> {
  const { API_URL, DEFAULT_PASSWORD } = await import("./support/env");
  const email = uniqueEmail("unverified");
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.7`,
  };
  await fetch(`${API_URL}/api/v1/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      password: DEFAULT_PASSWORD,
      display_name: "Linus Pauling",
      locale: "en",
      accept_terms: true,
    }),
  });
  const response = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: DEFAULT_PASSWORD }),
  });
  const cookies = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return { email, password: DEFAULT_PASSWORD, name: "Linus Pauling", cookies };
}

async function newContext(
  browser: Browser,
  viewport: ViewportName,
  theme: Theme,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme,
    locale: "en-US",
    timezoneId: "Europe/Paris",
    reducedMotion: "reduce",
    isMobile: viewport === "mobile",
    hasTouch: viewport !== "desktop",
  });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("gouvra.theme", value);
      localStorage.setItem("gouvra.lang", "en");
    } catch {
      /* ignore */
    }
  }, theme);
  return context;
}

test("capture every screen", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const fixture = await seed();
  const viewports = ONLY_VIEWPORTS ?? (Object.keys(VIEWPORTS) as ViewportName[]);
  const themes = ONLY_THEMES ?? THEMES;
  const screens = SCREENS.filter((screen) => !ONLY || ONLY.includes(screen.name));

  for (const viewport of viewports) {
    for (const theme of themes) {
      for (const screen of screens) {
        if (screen.viewports && !screen.viewports.includes(viewport)) continue;
        const context = await newContext(browser, viewport, theme);
        const user = screen.as && screen.as !== "anonymous" ? fixture[screen.as] : null;
        if (user) await signIn(context, user);
        const page = await context.newPage();
        await screen.setup?.(page, fixture);
        await page.goto(screen.path(fixture), { waitUntil: "networkidle" });
        await page.waitForTimeout(500);
        await screen.act?.(page, fixture);
        await page.waitForTimeout(700);
        await page.screenshot({
          path: `${OUT}/${screen.name}--${viewport}-${theme}.png`,
          fullPage: screen.fullPage ?? true,
        });
        await context.close();
      }
    }
  }
});
