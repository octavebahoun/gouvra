import {
  Boxes,
  ChartNoAxesCombined,
  Coins,
  FlaskConical,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { motion, useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { SectionHeading } from "./landing-shared";

const FEATURES: {
  key: "agents" | "traces" | "tools" | "evaluations" | "costs" | "teams";
  Icon: LucideIcon;
}[] = [
  { key: "traces", Icon: ChartNoAxesCombined },
  { key: "agents", Icon: Boxes },
  { key: "tools", Icon: Wrench },
  { key: "evaluations", Icon: FlaskConical },
  { key: "costs", Icon: Coins },
  { key: "teams", Icon: Users },
];

const TRACE_KEYS = ["started", "model", "tool", "answer", "done"] as const;

function FeatureTracePreview() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, { amount: 0.4 });
  const [step, setStep] = useState(reduced ? TRACE_KEYS.length : 0);

  useEffect(() => {
    if (reduced || !visible) return undefined;
    const delay = step >= TRACE_KEYS.length ? 2200 : step === 0 ? 400 : 900;
    const timer = window.setTimeout(
      () => setStep((s) => (s >= TRACE_KEYS.length ? 0 : s + 1)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [reduced, visible, step]);

  return (
    <div ref={ref} aria-hidden className="mt-6 rounded-card border border-line bg-sunken/70 p-3">
      <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <motion.div
          className="h-full origin-left rounded-full bg-brand"
          initial={false}
          animate={{ scaleX: Math.min(1, step / TRACE_KEYS.length) }}
          transition={{ duration: reduced ? 0 : 0.4, ease: [0.2, 0, 0, 1] }}
        />
      </div>
      <ol className="relative flex flex-col gap-1.5 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-px before:bg-line">
        {TRACE_KEYS.map((key, index) => {
          const shown = index < step;
          return (
            <li
              key={key}
              className={cn(
                "relative flex items-center gap-2.5 transition-opacity duration-300",
                shown ? "opacity-100" : "opacity-30",
              )}
            >
              <span
                className={cn(
                  "relative z-10 size-2.5 shrink-0 rounded-full ring-4 ring-sunken",
                  key === "done" ? "bg-success" : shown ? "bg-brand" : "bg-line-strong/50",
                )}
              />
              <span className="truncate text-[12px] font-medium text-ink">
                {t(`visual.steps.${key}`)}
              </span>
              <span className="ml-auto hidden truncate text-[11px] text-muted sm:block">
                {t(`visual.steps.${key}Detail`)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function useTilt() {
  const reduced = useReducedMotion() ?? false;
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const rotateX = useSpring(rx, { stiffness: 220, damping: 22, mass: 0.4 });
  const rotateY = useSpring(ry, { stiffness: 220, damping: 22, mass: 0.4 });

  return {
    rotateX,
    rotateY,
    onPointerMove: reduced
      ? undefined
      : (event: PointerEvent<HTMLLIElement>) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = (event.clientX - rect.left) / rect.width - 0.5;
          const py = (event.clientY - rect.top) / rect.height - 0.5;
          ry.set(px * 5);
          rx.set(py * -5);
          event.currentTarget.style.setProperty("--sx", `${event.clientX - rect.left}px`);
          event.currentTarget.style.setProperty("--sy", `${event.clientY - rect.top}px`);
        },
    onPointerLeave: reduced
      ? undefined
      : () => {
          rx.set(0);
          ry.set(0);
        },
  };
}

function FeatureCard({
  featureKey,
  Icon,
  featured,
  index,
}: {
  featureKey: (typeof FEATURES)[number]["key"];
  Icon: LucideIcon;
  featured?: boolean;
  index: number;
}) {
  const { t } = useTranslation("site");
  const tilt = useTilt();
  return (
    <motion.li
      variants={fadeUp}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
      style={
        {
          rotateX: tilt.rotateX,
          rotateY: tilt.rotateY,
          "--sx": "80%",
          "--sy": "0%",
        } as CSSProperties
      }
      className={cn(
        "group relative overflow-hidden rounded-panel border border-line bg-surface p-6 shadow-sm transition-[border-color,box-shadow] duration-300 [transform-style:preserve-3d]",
        "hover:border-line-strong hover:shadow-lg",
        "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition-opacity before:duration-300 hover:before:opacity-100",
        "before:bg-[radial-gradient(220px_circle_at_var(--sx)_var(--sy),color-mix(in_srgb,var(--gv-brand)_14%,transparent),transparent_70%)]",
        featured && "sm:col-span-2 lg:col-span-2 lg:row-span-2 lg:p-8",
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-2.5 left-2.5 size-2.5 border-t border-l border-line-strong/40 transition-colors duration-300 group-hover:border-brand"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-2.5 right-2.5 size-2.5 border-t border-r border-line-strong/40 transition-colors duration-300 group-hover:border-brand"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-2.5 left-2.5 size-2.5 border-b border-l border-line-strong/40 transition-colors duration-300 group-hover:border-brand"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 bottom-2.5 size-2.5 border-r border-b border-line-strong/40 transition-colors duration-300 group-hover:border-brand"
      />
      <span
        aria-hidden
        className="absolute -top-16 -right-16 size-44 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_16%,transparent),transparent)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100"
      >
        <span className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-brand/8 to-transparent group-hover:animate-shimmer" />
      </span>
      <span className="flex items-start justify-between">
        <span className="inline-flex size-10 items-center justify-center rounded-card bg-brand-soft text-brand-text transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-3">
          <Icon aria-hidden className="size-5" />
        </span>
        <span className="font-mono text-[11px] text-muted tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>
      </span>
      <h3 className={cn("mt-5 font-semibold text-ink", featured ? "text-lg" : "text-base")}>
        {t(`features.items.${featureKey}.title`)}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {t(`features.items.${featureKey}.body`)}
      </p>
      {featured ? <FeatureTracePreview /> : null}
    </motion.li>
  );
}

export function Features() {
  const { t } = useTranslation("site");
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="scroll-mt-20 px-4 py-24 sm:px-6"
    >
      <SectionHeading
        id="features-title"
        eyebrow={t("features.eyebrow")}
        title={t("features.title")}
        body={t("features.subtitle")}
      />
      <motion.ul
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
        variants={staggerChildren(0.07)}
        className="mx-auto mt-14 grid max-w-6xl gap-4 [perspective:1200px] sm:grid-cols-2 lg:grid-cols-3"
      >
        {FEATURES.map(({ key, Icon }, index) => (
          <FeatureCard
            key={key}
            featureKey={key}
            Icon={Icon}
            featured={key === "traces"}
            index={index}
          />
        ))}
      </motion.ul>
    </section>
  );
}
