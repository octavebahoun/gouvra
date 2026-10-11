import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Announce = (message: string, politeness?: "polite" | "assertive") => void;
const AnnounceContext = createContext<Announce>(() => undefined);

/**
 * Screen-reader announcements for important changes (execution finished, saved, ...).
 * Messages are debounced so a stream of events does not cause excessive reading.
 */
export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const timer = useRef<number | undefined>(undefined);

  const announce = useCallback<Announce>((message, politeness = "polite") => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (politeness === "assertive") {
        setAssertive("");
        window.requestAnimationFrame(() => setAssertive(message));
      } else {
        setPolite("");
        window.requestAnimationFrame(() => setPolite(message));
      }
    }, 250);
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
