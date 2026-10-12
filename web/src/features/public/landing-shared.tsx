import { motion, useTransform, type MotionValue } from "motion/react";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { fadeUp, staggerChildren } from "@/components/motion/presets";

export type Spotlight = {
  x: MotionValue<number>;
  y: MotionValue<number>;
  opacity: MotionValue<number>;
};

/** Gouvra heading dial — the same mark as the logo, drawn large and faint. */
export function DialMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden
      className={cn("motion-safe:animate-[spin_90s_linear_infinite]", className)}
    >
      <circle
        cx="100"
        cy="100"
        r="94"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeDasharray="2 7"
        opacity="0.45"
      />
      <circle
        cx="100"
        cy="100"
        r="70"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.3"
      />
      {Array.from({ length: 24 }, (_, i) => {
        const angle = (i * Math.PI) / 12;
        const major = i % 6 === 0;
        const inner = major ? 86 : 90;
        return (
          <line
            key={i}
            x1={100 + Math.cos(angle) * inner}
            y1={100 + Math.sin(angle) * inner}
            x2={100 + Math.cos(angle) * 96}
            y2={100 + Math.sin(angle) * 96}
            stroke="currentColor"
            strokeWidth={major ? 1.6 : 0.7}
            strokeLinecap="round"
            opacity={major ? 0.85 : 0.4}
          />
        );
      })}
      <path
        d="M 140 60 A 56 56 0 1 0 156 100"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path
        d="M 156 100 H 114"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        opacity="0.45"
      />
      <circle cx="100" cy="100" r="5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

/**
 * Heading dial for the landing compass. Ticks stay fixed; only the needle follows `rotation`
 * (degrees, 0 = up), so the mark shows where you are on the page.
 */
export function CompassDial({
  rotation,
  className,
}: {
  rotation: MotionValue<number>;
  className?: string;
}) {
  const rad = useTransform(rotation, (deg) => ((deg - 90) * Math.PI) / 180);
  const x2 = useTransform(rad, (r) => 40 + Math.cos(r) * 16);
  const y2 = useTransform(rad, (r) => 40 + Math.sin(r) * 16);
  return (
    <svg viewBox="0 0 80 80" aria-hidden className={className}>
      <circle
        cx="40"
        cy="40"
        r="36"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.7"
        opacity="0.35"
      />
      <circle
        cx="40"
        cy="40"
        r="26"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.22"
      />
      {[0, 90, 180, 270].map((deg) => {
        const r = ((deg - 90) * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={40 + Math.cos(r) * 29}
            y1={40 + Math.sin(r) * 29}
            x2={40 + Math.cos(r) * 36}
            y2={40 + Math.sin(r) * 36}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        );
      })}
      <motion.line
        x1={40}
        y1={40}
        x2={x2}
        y2={y2}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="40" cy="40" r="2.4" className="fill-canvas" />
      <circle cx="40" cy="40" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Grid, drifting glows, grain, heading dial, optional pointer spotlight. */
export function LandingAtmosphere({
  spotlight,
  className,
  dialClassName,
}: {
  spotlight?: Spotlight;
  className?: string;
  dialClassName?: string;
}) {
  const grainId = useId();
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}
    >
      <div className="absolute inset-[-48px] bg-[linear-gradient(to_right,var(--gv-line)_1px,transparent_1px),linear-gradient(to_bottom,var(--gv-line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_50%_18%,black_22%,transparent_72%)] bg-[size:48px_48px] opacity-50 motion-safe:animate-[gv-drift_32s_ease-in-out_infinite]" />
      <div className="absolute top-[-14rem] left-1/2 h-[40rem] w-[70rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_18%,transparent),transparent)] motion-safe:animate-[gv-drift_22s_ease-in-out_infinite]" />
      <div className="absolute top-[28%] -right-40 size-[32rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-chart-2)_10%,transparent),transparent)] motion-safe:animate-[gv-drift_28s_ease-in-out_infinite_reverse]" />
      <DialMark
        className={cn(
          "absolute top-10 left-1/2 h-[min(42rem,88vw)] w-[min(42rem,88vw)] -translate-x-1/2 text-brand opacity-[0.13] lg:top-6 lg:left-[22%]",
          dialClassName,
        )}
      />
      <svg className="absolute inset-0 h-full w-full opacity-[0.035] mix-blend-overlay">
        <filter id={grainId}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="4"
            stitchTiles="stitch"
          />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${grainId})`} />
      </svg>
      {spotlight ? (
        <motion.div
          style={{ left: spotlight.x, top: spotlight.y, opacity: spotlight.opacity }}
          className="absolute size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_20%,transparent),transparent)]"
        />
      ) : null}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  body,
  id,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  id: string;
}) {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.5 }}
      variants={staggerChildren(0.08)}
      className="mx-auto max-w-2xl text-center"
    >
      <motion.p
        variants={fadeUp}
        className="text-xs font-semibold tracking-[0.14em] text-brand-text uppercase"
      >
        {eyebrow}
      </motion.p>
      <motion.h2
        id={id}
        variants={fadeUp}
        className="mt-3 text-3xl font-semibold tracking-[-0.025em] text-balance text-ink sm:text-4xl"
      >
        {title}
      </motion.h2>
      {body ? (
        <motion.p
          variants={fadeUp}
          className="mt-4 text-base leading-relaxed text-pretty text-muted"
        >
          {body}
        </motion.p>
      ) : null}
    </motion.div>
  );
}
