import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * Gouvra mark: a "G" drawn as a steering dial — the open arc is the dial, the bar is the
 * heading needle, the dot is the pivot. Original artwork, see docs/brand.md.
 */
export function LogoMark({
  className,
  animated = false,
}: {
  className?: string;
  animated?: boolean;
}) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7 shrink-0", className)}>
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3B7BFF" />
          <stop offset="1" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <path
        d="M21.66 10.34 A8 8 0 1 0 24 16"
        fill="none"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        className={
          animated
            ? "origin-center motion-safe:animate-[gv-dial_1.2s_cubic-bezier(0.2,0,0,1)_both]"
            : undefined
        }
      />
      <path d="M24 16 H17.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.9" fill="#9BE7FF" />
    </svg>
  );
}

export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">gouvra</span>
    </span>
  );
}
