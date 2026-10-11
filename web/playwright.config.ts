import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const chrome = devices["Desktop Chrome"];

/**
 * End-to-end suite against a running stack (default: Docker Compose on :8080, with Mailpit).
 * - desktop: user journeys, keyboard paths, accessibility of every screen;
 * - tablet / mobile: accessibility and layout of every screen at those widths;
 * - screenshots: every screen × 3 widths × light/dark into e2e/screenshots/ (`pnpm screenshots`).
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /screenshots\.spec\.ts/,
      use: { ...chrome, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet",
      testMatch: /screens\.spec\.ts/,
      use: { ...chrome, viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
    {
      name: "mobile",
      testMatch: /screens\.spec\.ts/,
      use: { ...chrome, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "screenshots",
      testMatch: /screenshots\.spec\.ts/,
      timeout: 600_000,
      use: { ...chrome, viewport: { width: 1440, height: 900 } },
    },
  ],
});
