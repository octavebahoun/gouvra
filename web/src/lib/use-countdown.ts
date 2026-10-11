import { useEffect, useState } from "react";

/** Seconds left until `deadline` (epoch ms), updated every half second; 0 once reached or unset. */
export function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const done = deadline === null || deadline <= now;
  useEffect(() => {
    if (done) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [done, deadline]);
  if (deadline === null) return 0;
  return Math.max(0, Math.min(Math.ceil((deadline - now) / 1000), 24 * 3600));
}
