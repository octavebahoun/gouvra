import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

type AnimatedNumberProps = {
  value: number;
  format?: (value: number) => string;
  className?: string;
  /** Seconds. Counters roll quickly so they never lag behind live data. */
  duration?: number;
};

/**
 * Number that rolls to its new value (durations, token counts, costs).
 * Uses tabular figures so digits don't jitter; renders the final value at once with reduced motion.
 */
export function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toLocaleString(),
  className,
  duration = 0.6,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = previous.current;
    previous.current = value;
    if (reduced || from === value) {
      node.textContent = format(value);
      return;
    }
    const controls = animate(from, value, {
      duration,
      ease: [0.2, 0, 0, 1],
      onUpdate: (latest) => {
        node.textContent = format(latest);
      },
    });
    return () => controls.stop();
  }, [value, format, reduced, duration]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {format(value)}
    </span>
  );
}
