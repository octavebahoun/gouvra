/** Pretty JSON for display (stable 2-space indentation). */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Parse JSON typed by a person: the value, or the parser's message to show next to the field. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
