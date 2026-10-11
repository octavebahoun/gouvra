/** Where the suite runs. E-mail links point at APP_URL; tests replay them on E2E_BASE_URL. */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
/** Direct API access, used only to prepare data (users, workspaces) quickly. */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8000";
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";

export const DEFAULT_PASSWORD = "Tidal-harbor-lantern-42";

export function uniqueEmail(tag = "user"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `e2e+${tag}-${Date.now().toString(36)}${random}@example.com`;
}
