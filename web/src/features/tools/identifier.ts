/** "Order lookup" → "order_lookup": the identifier models call the tool by. */
export function toIdentifier(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[a-z]/.test(base) ? base : `tool_${base}`.slice(0, 64);
}
