/** Mirrors the API's slug generation, for the live preview (the API stays the authority). */
export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // eslint-disable-next-line no-control-regex -- drop every non-ASCII character, like the API
    .replace(/[^\x00-\x7f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "workspace").slice(0, 40).replace(/-+$/, "");
}

/** What the API will try first for this name (very short names get a suffix). */
export function suggestedSlug(name: string): string {
  const base = slugify(name);
  return base.length >= 3 ? base : `${base}-ws`;
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 48 && SLUG_PATTERN.test(slug);
}

/** The address shown to people: host + path, without the protocol. */
export function workspaceAddress(slug: string): string {
  return `${window.location.host}/w/${slug}`;
}
