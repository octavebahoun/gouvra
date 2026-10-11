/** Formatting for execution metrics: durations, token counts and costs (locale-aware). */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return "< 1 ms";
  if (ms < 1000) return `${Math.round(ms).toLocaleString()} ms`;
  const seconds = ms / 1000;
  if (seconds < 60)
    return `${seconds.toLocaleString(undefined, { maximumFractionDigits: seconds < 10 ? 2 : 1 })} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60)
    return rest
      ? `${minutes.toLocaleString()} min ${rest.toLocaleString()} s`
      : `${minutes.toLocaleString()} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins
    ? `${hours.toLocaleString()} h ${mins.toLocaleString()} min`
    : `${hours.toLocaleString()} h`;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return "—";
  return count < 10_000 ? count.toLocaleString() : compact.format(count);
}

/**
 * Money with enough precision for per-call costs ($0.00042) without noise on large sums.
 * Amounts come from the API as decimal strings; null means "no price known" (never zero).
 */
export function formatCost(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency ?? ""}`.trim();
  }
}
