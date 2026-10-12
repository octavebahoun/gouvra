import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { ease } from "@/components/motion/presets";
import { SectionHeading } from "./landing-shared";

const ITEMS = ["connect", "build", "run"] as const;
type StepKey = (typeof ITEMS)[number];

function StepNeedle({ index }: { index: number }) {
  const reduced = useReducedMotion();
  return (
    <svg viewBox="0 0 32 32" aria-hidden className="size-7 text-brand">
      <circle
        cx="16"
        cy="16"
        r="13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.7"
        opacity="0.35"
      />
      <motion.g
        initial={false}
        animate={{ rotate: reduced ? 0 : index * 120 }}
        transition={{ duration: reduced ? 0 : 0.5, ease: ease.standard }}
        style={{ transformOrigin: "16px 16px" }}
      >
        <line
          x1="16"
          y1="16"
          x2="16"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </motion.g>
      <circle cx="16" cy="16" r="1.6" fill="currentColor" />
    </svg>
  );
}

function StepsList() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const ref = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 80%", "end 60%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 28 });
  const height = useTransform(progress, [0, 1], reduced ? ["100%", "100%"] : ["0%", "100%"]);

  return (
    <ol ref={ref} className="relative mx-auto mt-14 flex max-w-2xl flex-col gap-10">
      <span
        aria-hidden
        className="absolute top-2 bottom-2 left-[19px] w-0.5 rounded-full bg-line"
      />
      <motion.span
        aria-hidden
        style={{ height }}
        className="absolute top-2 left-[19px] w-0.5 rounded-full bg-brand"
      />
      {ITEMS.map((key, index) => (
        <motion.li
          key={key}
          initial={{ opacity: 0, x: reduced ? 0 : -16 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.5, ease: ease.standard }}
          className="relative flex gap-5"
        >
          <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-brand bg-surface text-sm font-semibold text-brand-text tabular-nums">
            {index + 1}
          </span>
          <div className="pt-1.5">
            <h3 className="text-lg font-semibold text-ink">{t(`steps.items.${key}.title`)}</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">
              {t(`steps.items.${key}.body`)}
            </p>
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

function ProviderRow({ name, delay, active }: { name: string; delay: number; active: boolean }) {
  return (
    <motion.div
      initial={false}
      animate={active ? { opacity: 1, x: 0 } : { opacity: 0.35, x: 0 }}
      transition={{ duration: 0.45, delay: active ? delay : 0, ease: ease.standard }}
      className="flex items-center gap-3 rounded-card border border-line bg-surface px-3 py-2.5"
    >
      <span className="size-1.5 rounded-full bg-brand" />
      <span className="text-[13px] font-medium text-ink">{name}</span>
    </motion.div>
  );
}

function ConnectScene({ active }: { active: boolean }) {
  const { t } = useTranslation("site");
  const names = ["DeepSeek", "Anthropic Claude", "OpenAI-compatible APIs", t("trust.offline")];
  return (
    <div className="space-y-2">
      {names.map((name, i) => (
        <ProviderRow key={name} name={name} delay={i * 0.08} active={active} />
      ))}
    </div>
  );
}

function BuildScene({ active }: { active: boolean }) {
  const { t } = useTranslation("site");
  const rows = [
    t("visual.agent"),
    t("visual.steps.startedDetail"),
    t("features.items.tools.title"),
  ];
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-[11px] font-medium tracking-[0.1em] text-muted uppercase">
        {t("features.items.agents.title")}
      </p>
      <ul className="mt-3 space-y-2.5">
        {rows.map((row, i) => (
          <motion.li
            key={row}
            initial={false}
            animate={active ? { opacity: 1, scaleX: 1 } : { opacity: 0.35, scaleX: 1 }}
            transition={{ duration: 0.4, delay: active ? i * 0.1 : 0, ease: ease.standard }}
            className="flex items-center gap-3"
          >
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <motion.span
                initial={false}
                animate={{ scaleX: active ? 1 : 0.2 }}
                transition={{
                  duration: 0.7,
                  delay: active ? 0.12 + i * 0.1 : 0,
                  ease: ease.standard,
                }}
                className="block h-full origin-left rounded-full bg-brand/70"
              />
            </span>
            <span className="w-36 truncate text-xs text-ink">{row}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function RunScene({ active }: { active: boolean }) {
  const { t } = useTranslation("site");
  const keys = ["started", "model", "tool", "done"] as const;
  return (
    <ol className="space-y-2">
      {keys.map((key, i) => (
        <motion.li
          key={key}
          initial={false}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0.35, y: 0 }}
          transition={{ duration: 0.4, delay: active ? i * 0.1 : 0, ease: ease.standard }}
          className="flex items-center gap-3 rounded-card border border-line bg-surface px-3 py-2"
        >
          <span className={cn("size-2 rounded-full", key === "done" ? "bg-success" : "bg-brand")} />
          <span className="text-[13px] font-medium text-ink">{t(`visual.steps.${key}`)}</span>
          <span className="ml-auto truncate text-[11px] text-muted">
            {t(`visual.steps.${key}Detail`)}
          </span>
        </motion.li>
      ))}
    </ol>
  );
}

function Scene({ step, active }: { step: StepKey; active: boolean }) {
  if (step === "connect") return <ConnectScene active={active} />;
  if (step === "build") return <BuildScene active={active} />;
  return <RunScene active={active} />;
}

function StepsCinema() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [index, setIndex] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (value) => {
    setIndex(value < 1 / 3 ? 0 : value < 2 / 3 ? 1 : 2);
  });
  const fill = useSpring(scrollYProgress, { stiffness: 140, damping: 28 });
  const height = useTransform(fill, [0, 1], reduced ? ["100%", "100%"] : ["0%", "100%"]);
  const current = ITEMS[index] ?? "connect";

  return (
    <div ref={ref} className="relative mt-6 h-[220vh]">
      <div className="sticky top-16 flex h-[calc(100dvh-4rem)] items-center">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
          <ol className="relative flex flex-col gap-2 pl-2">
            <span
              aria-hidden
              className="absolute top-3 bottom-3 left-[19px] w-0.5 rounded-full bg-line"
            />
            <motion.span
              aria-hidden
              style={{ height }}
              className="absolute top-3 left-[19px] w-0.5 rounded-full bg-brand"
            />
            {ITEMS.map((key, i) => {
              const on = i === index;
              return (
                <li key={key} className="relative flex gap-5 py-3">
                  <span
                    className={cn(
                      "relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold tabular-nums transition-colors duration-300",
                      on
                        ? "border-brand bg-brand text-on-solid"
                        : "border-line bg-surface text-muted",
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 pt-1.5">
                    <h3
                      className={cn(
                        "text-lg font-semibold transition-colors duration-300",
                        on ? "text-ink" : "text-muted",
                      )}
                    >
                      {t(`steps.items.${key}.title`)}
                    </h3>
                    <p
                      className={cn(
                        "mt-1.5 text-[15px] leading-relaxed text-muted transition-[opacity,max-height] duration-300",
                        on ? "max-h-32 opacity-100" : "max-h-0 overflow-hidden opacity-0",
                      )}
                    >
                      {t(`steps.items.${key}.body`)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="relative overflow-hidden rounded-panel border border-line bg-sunken/80 p-6 shadow-lg">
            <div
              aria-hidden
              className="absolute inset-0 bg-[linear-gradient(to_right,var(--gv-line)_1px,transparent_1px),linear-gradient(to_bottom,var(--gv-line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_50%_40%,black,transparent_75%)] bg-[size:28px_28px] opacity-40"
            />
            <div className="relative">
              <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted">
                <StepNeedle index={index} />
                {t(`steps.items.${current}.title`)}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={current}
                  initial={reduced ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 1 } : { opacity: 0, y: -10 }}
                  transition={{ duration: 0.4, ease: ease.standard }}
                >
                  <Scene step={current} active />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Steps() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 bg-surface/50 py-24">
      <div className="px-4 sm:px-6">
        <SectionHeading id="how-title" eyebrow={t("steps.eyebrow")} title={t("steps.title")} />
      </div>
      {reduced ? (
        <div className="px-4 sm:px-6">
          <StepsList />
        </div>
      ) : (
        <>
          <div className="px-4 sm:px-6 lg:hidden">
            <StepsList />
          </div>
          <div className="hidden lg:block">
            <StepsCinema />
          </div>
        </>
      )}
    </section>
  );
}
