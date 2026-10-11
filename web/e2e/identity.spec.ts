import { expect, test } from "@playwright/test";
import {
  addMember,
  createVerifiedUser,
  createWorkspace,
  invite,
  signIn,
  type SeededUser,
} from "./support/api";
import { DEFAULT_PASSWORD, uniqueEmail } from "./support/env";
import { waitForLink } from "./support/mailpit";

/**
 * Identity journeys through the real stack: API, worker, e-mail (Mailpit) and the web app.
 * Every e-mail link is read from the message the user would actually receive.
 */

test("sign up, confirm the e-mail, create a workspace and reach its overview", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Grace Hopper");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEFAULT_PASSWORD);
  await page.getByLabel("I accept the terms of use of this Gouvra instance.").check();
  const since = Date.now();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

  await page.goto(await waitForLink(email, "/verify-email", { since }));
  await expect(page.getByRole("heading", { name: "Your e-mail is confirmed" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Create my workspace" }).click();
  await page.getByLabel("Workspace name").fill("Hopper Labs");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Hopper Labs is ready" })).toBeVisible();
  await page.getByRole("button", { name: /Go to Hopper Labs/ }).click();
  await expect(page).toHaveURL(/\/w\/hopper-labs[\w-]*\/overview$/);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
});

test("sign in with the keyboard, then sign out", async ({ page }) => {
  const user = await createVerifiedUser({ tag: "keyboard" });
  await createWorkspace(user, "Keyboard Co");
  await page.goto("/login");
  await page.getByLabel("E-mail").focus();
  await page.keyboard.type(user.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(user.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/keyboard-co[\w-]*\/overview$/);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("a wrong password gets a neutral answer", async ({ page }) => {
  const user = await createVerifiedUser({ tag: "wrong" });
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("Not-the-right-one-99");
  await page.getByRole("button", { name: "Sign in" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Incorrect e-mail or password" });
  await expect(alert).toBeVisible();
  // Same words for an address that has no account: nothing to enumerate.
  await page.getByLabel("E-mail").fill(uniqueEmail("nobody"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alert).toBeVisible();
});

test("forgot password: the e-mailed link sets a new one and signs in", async ({ page }) => {
  const user = await createVerifiedUser({ tag: "reset" });
  await page.goto("/forgot-password");
  await page.getByLabel("E-mail").fill(user.email);
  const since = Date.now();
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

  await page.goto(await waitForLink(user.email, "/reset-password", { since }));
  const fresh = "Quiet-orchard-compass-77";
  await page.getByLabel("New password", { exact: true }).fill(fresh);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(fresh);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test("an invited teammate joins from the e-mail link", async ({ browser }) => {
  const owner = await createVerifiedUser({ tag: "owner", name: "Ada Lovelace" });
  const workspace = await createWorkspace(owner, "Analytical Engines");
  const guest: SeededUser = await createVerifiedUser({ tag: "guest", name: "Charles Babbage" });
  const since = Date.now();
  await invite(owner, workspace.id, guest.email, "member");

  const context = await browser.newContext();
  await signIn(context, guest);
  const page = await context.newPage();
  await page.goto(await waitForLink(guest.email, "/invite", { since }));
  await expect(page.getByRole("heading", { name: "Join Analytical Engines" })).toBeVisible();
  await page.getByRole("button", { name: "Accept and join" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/overview$`));
  await context.close();
});

test("owners manage members, roles and service keys", async ({ browser }) => {
  const owner = await createVerifiedUser({ tag: "admin", name: "Ada Lovelace" });
  const workspace = await createWorkspace(owner, "Difference Engine");
  const member = await createVerifiedUser({ tag: "member", name: "Mary Somerville" });
  await addMember(owner, workspace, member, "viewer");

  const context = await browser.newContext();
  await signIn(context, owner);
  const page = await context.newPage();
  await page.goto(`/w/${workspace.slug}/settings/members`);
  await page.getByRole("combobox", { name: "Role of Mary Somerville" }).click();
  await page.getByRole("option", { name: /Member/ }).click();
  await expect(page.getByText(/Mary Somerville is now member/i)).toBeVisible();

  await page.getByRole("link", { name: "API keys" }).click();
  await page.getByRole("button", { name: "Create a key" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Nightly export");
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(page.getByText(/gvr_live_[A-Za-z0-9_-]{20,}/)).toBeVisible();
  await page.getByRole("button", { name: "I've stored it" }).click();
  // The full key is never shown again.
  await expect(page.getByText(/gvr_live_[A-Za-z0-9_-]{20,}/)).toHaveCount(0);

  await page.getByRole("button", { name: "Revoke Nightly export" }).click();
  const confirm = page.getByRole("dialog");
  const revoke = confirm.getByRole("button", { name: "Revoke key" });
  await expect(revoke).toBeDisabled(); // the name must be typed first
  await confirm.getByRole("textbox").fill("Nightly export");
  await revoke.click();
  await expect(page.getByText(/Key “Nightly export” revoked/)).toBeVisible();
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();
  await context.close();
});

test("preferences: theme and language follow the account", async ({ browser }) => {
  const user = await createVerifiedUser({ tag: "prefs" });
  await createWorkspace(user, "Prefs");
  const context = await browser.newContext();
  await signIn(context, user);
  const page = await context.newPage();
  await page.goto("/account");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Français" }).click();
  await expect(
    page.getByRole("heading", { name: "Profil et préférences", level: 1 }),
  ).toBeVisible();

  // A fresh device gets the same choices from the profile.
  const other = await browser.newContext();
  await signIn(other, user);
  const second = await other.newPage();
  await second.goto("/account");
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("Profil et préférences");
  await other.close();
  await context.close();
});
