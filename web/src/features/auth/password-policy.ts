/** Password policy (D-067), mirrored from the API for live feedback only. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Same rule as the API: the address itself, or its local part (4+ characters), inside. */
export function containsEmail(password: string, email: string | undefined): boolean {
  const address = (email ?? "").trim().toLowerCase();
  if (!address || !password) return false;
  const lowered = password.toLowerCase();
  const local = address.split("@")[0] ?? "";
  return lowered === address || (local.length >= 4 && lowered.includes(local));
}
