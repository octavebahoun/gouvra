import { useEffect } from "react";

/** Every page has its own title (WCAG 2.4.2), e.g. "Sign in · Gouvra". */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = `${title} · Gouvra`;
  }, [title]);
}
