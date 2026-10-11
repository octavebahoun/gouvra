/**
 * Small per-browser conveniences kept in localStorage. Every access is guarded: storage can be
 * unavailable (private mode, blocked site data) and the app must keep working without it.
 */

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the feature degrades to "not remembered" */
  }
}

// ---------------------------------------------------------------- last workspace (per user)

const lastWorkspaceKey = (userId: string) => `gouvra.lastWorkspace.${userId}`;

export function readLastWorkspace(userId: string): string | null {
  return read(lastWorkspaceKey(userId));
}

export function rememberLastWorkspace(userId: string, slug: string): void {
  if (read(lastWorkspaceKey(userId)) !== slug) write(lastWorkspaceKey(userId), slug);
}

// ---------------------------------------------------------------- pending invitation

/**
 * An invitation link opened while signed out is kept until the person signs in or confirms a new
 * account — possibly in another tab, from the verification e-mail — then resumed at `/invite`.
 */
const PENDING_INVITE_KEY = "gouvra.pendingInvite";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function savePendingInvite(token: string): void {
  write(PENDING_INVITE_KEY, JSON.stringify({ token, savedAt: Date.now() }));
}

export function readPendingInvite(): string | null {
  const raw = read(PENDING_INVITE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "token" in value &&
      "savedAt" in value &&
      typeof value.token === "string" &&
      typeof value.savedAt === "number" &&
      Date.now() - value.savedAt < INVITE_TTL_MS
    ) {
      return value.token;
    }
  } catch {
    /* corrupted value: dropped below */
  }
  write(PENDING_INVITE_KEY, null);
  return null;
}

export function clearPendingInvite(): void {
  write(PENDING_INVITE_KEY, null);
}

// ---------------------------------------------------------------- preferences chosen while signed out

/** Set when someone picks a theme or language before signing in: their choice wins at sign-in. */
const LOCAL_PREFS_KEY = "gouvra.prefs.chosenSignedOut";

export function markLocalPreferencesChosen(): void {
  write(LOCAL_PREFS_KEY, "1");
}

export function takeLocalPreferencesChosen(): boolean {
  const chosen = read(LOCAL_PREFS_KEY) === "1";
  if (chosen) write(LOCAL_PREFS_KEY, null);
  return chosen;
}
