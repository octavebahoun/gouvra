import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * Success-rate ring. The arc draws in once; the value is also written in the centre, so the
 * colour is never the only carrier of the information.
 */
export function RingGauge({
  value,
  label,
  size = 96,
  className,
}: {
  /** 0–1, or null when there is nothing to measure yet. */
  value: number | null;
  label: string;
  size?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, value));
  const tone =
    value === null
      ? "var(--gv-line-strong)"
      : ratio >= 0.9
        ? "var(--gv-success)"
        : ratio >= 0.7
          ? "var(--gv-warning)"
          : "var(--gv-danger)";
  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--gv-surface-2)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - ratio) }}
          transition={reduced ? { duration: 0 } : { duration: 0.9, ease: [0.2, 0, 0, 1] }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-semibold text-ink tabular-nums">
          {value === null ? "—" : `${Math.round(ratio * 100)}%`}
        </span>
        <span className="sr-only">{label}</span>
      </span>
    </div>
  );
}

type SparkPoint = { ok: number; failed: number };

/**
 * Tiny stacked bars (succeeded / failed per bucket) that grow in from the baseline.
 * Purely illustrative next to the exact numbers it summarises (aria-hidden).
 */
export function ActivityBars({ points, className }: { points: SparkPoint[]; className?: string }) {
  const reduced = useReducedMotion();
  const id = useId();
  const max = Math.max(1, ...points.map((p) => p.ok + p.failed));
  const width = 100 / Math.max(points.length, 1);
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden
      className={cn("h-10 w-full", className)}
    >
      <defs>
        <linearGradient id={`${id}-ok`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--gv-brand)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--gv-brand)" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {points.map((point, index) => {
        const okHeight = (point.ok / max) * 30;
        const failHeight = (point.failed / max) * 30;
        const x = index * width + width * 0.18;
        const w = width * 0.64;
        return (
          <g key={index}>
            <rect x={x} width={w} y={30.5} height={1.5} rx={0.75} fill="var(--gv-line)" />
            <motion.rect
              x={x}
              width={w}
              rx={0.8}
              fill={`url(#${id}-ok)`}
              initial={{ height: 0, y: 32 }}
              animate={{ height: okHeight, y: 32 - okHeight }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.5, delay: index * 0.015, ease: [0.2, 0, 0, 1] }
              }
            />
            <motion.rect
              x={x}
              width={w}
              rx={0.8}
              fill="var(--gv-danger)"
              initial={{ height: 0, y: 32 - okHeight }}
              animate={{ height: failHeight, y: 32 - okHeight - failHeight }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.5, delay: 0.1 + index * 0.015, ease: [0.2, 0, 0, 1] }
              }
            />
          </g>
        );
      })}
    </svg>
  );
}
