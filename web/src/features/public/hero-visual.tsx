import {
  Bot,
  CircleCheck,
  MessageSquareText,
  Play,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

type StepKey = "started" | "model" | "tool" | "answer" | "done";
const STEPS: { key: StepKey; Icon: LucideIcon; tone: string }[] = [
  { key: "started", Icon: Play, tone: "bg-brand-soft text-brand-text" },
  { key: "model", Icon: Sparkles, tone: "bg-brand-soft text-brand-text" },
  { key: "tool", Icon: Wrench, tone: "bg-warning-soft text-warning-text" },
  { key: "answer", Icon: MessageSquareText, tone: "bg-brand-soft text-brand-text" },
  { key: "done", Icon: CircleCheck, tone: "bg-success-soft text-success-text" },
];
const STEP_MS = 1150;
const HOLD_MS = 2600;

/**
 * The run the hero replays: steps appear one by one, the answer is "typed", counters roll and
 * the status turns from a breathing "running" to "succeeded"; then it starts over. Only while
 * visible, and not at all with reduced motion (the finished run is shown instead).
 */
function usePlayback(ref: RefObject<HTMLElement | null>, reduced: boolean) {
  const visible = useInView(ref, { amount: 0.25 });
  const [step, setStep] = useState(reduced ? STEPS.length : 0);
  useEffect(() => {
    if (reduced || !visible) return undefined;
    const delay = step >= STEPS.length ? HOLD_MS : step === 0 ? 500 : STEP_MS;
    const timer = window.setTimeout(() => setStep((s) => (s >= STEPS.length ? 0 : s + 1)), delay);
    return () => window.clearTimeout(timer);
  }, [step, visible, reduced]);
  return reduced ? STEPS.length : step;
}

function Rolling({
  to,
  active,
  format,
}: {
  to: number;
  active: boolean;
  format: (v: number) => string;
}) {
  return active ? (
    <RollingValue to={to} format={format} />
  ) : (
    <span className="tabular-nums">{format(0)}</span>
  );
}

function RollingValue({ to, format }: { to: number; format: (v: number) => string }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 1600);
      setValue(to * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to]);
  return <span className="tabular-nums">{format(value)}</span>;
}

function TypedText({ text, active }: { text: string; active: boolean }) {
  return active ? <Typing text={text} /> : null;
}

function Typing({ text }: { text: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCount((c) => Math.min(text.length, c + 2));
    }, 28);
    return () => window.clearInterval(timer);
  }, [text]);
  return (
    <>
      {text.slice(0, count)}
      {count < text.length ? (
        <span className="ml-0.5 inline-block h-3 w-1 translate-y-0.5 animate-pulse rounded-[1px] bg-brand" />
      ) : null}
    </>
  );
}

/**
 * Hero illustration: a live execution in a tilted "control room" window that straightens as you
 * scroll, with floating instruments at different depths. Decorative (aria-hidden); the
 * sentence in `visualLabel` describes it for assistive technologies.
 */
export function HeroVisual({ target }: { target: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const step = usePlayback(ref, reduced);
  const done = step >= STEPS.length;
  const running = step > 0 && !done;

  const { scrollYProgress } = useScroll({ target, offset: ["start start", "end start"] });
  const smooth = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const rotateX = useTransform(smooth, [0, 0.5], reduced ? [0, 0] : [16, 0]);
  const scale = useTransform(smooth, [0, 0.5], reduced ? [1, 1] : [0.94, 1]);
  const lift = useTransform(smooth, [0, 1], reduced ? [0, 0] : [0, -60]);
  const farY = useTransform(smooth, [0, 1], reduced ? [0, 0] : [0, -140]);
  const nearY = useTransform(smooth, [0, 1], reduced ? [0, 0] : [0, 90]);

  return (
    <div
      ref={ref}
      aria-hidden
      data-decorative
      className="relative mx-auto w-full max-w-4xl [perspective:1600px]"
    >
      {/* Floating instruments, at their own depth. */}
      <motion.div
        style={{ y: farY }}
        className="absolute -top-12 -left-14 z-20 hidden w-44 rounded-card border border-line bg-surface/95 p-3 shadow-lg backdrop-blur md:block"
      >
        <p className="text-[11px] font-medium text-muted">{t("visual.success")}</p>
        <div className="mt-2 flex items-center gap-3">
          <svg viewBox="0 0 36 36" className="size-10 -rotate-90">
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--gv-surface-2)"
              strokeWidth="4"
            />
            <motion.circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--gv-success)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={94.2}
              initial={{ strokeDashoffset: 94.2 }}
              animate={{ strokeDashoffset: 94.2 * 0.04 }}
              transition={{ duration: reduced ? 0 : 1.6, ease: [0.2, 0, 0, 1], delay: 0.6 }}
            />
          </svg>
          <span className="text-xl font-semibold text-ink tabular-nums">96%</span>
        </div>
      </motion.div>
      <motion.div
        style={{ y: nearY }}
        className="absolute -right-14 -bottom-8 z-20 hidden w-48 rounded-card border border-line bg-surface/95 p-3 shadow-lg backdrop-blur md:block"
      >
        <p className="text-[11px] font-medium text-muted">{t("visual.cost")}</p>
        <p className="mt-1 text-xl font-semibold text-ink tabular-nums">≈ $0.0002</p>
        <p className="text-[11px] text-muted">{t("visual.estimated")} · deepseek-flash</p>
      </motion.div>

      <motion.div
        style={{ rotateX, scale, y: lift, transformOrigin: "50% 0%" }}
        className="relative z-10 overflow-hidden rounded-panel border border-line bg-surface shadow-[0_40px_120px_-30px_color-mix(in_srgb,var(--gv-brand)_45%,transparent)]"
      >
        {/* Window chrome */}
        <div className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-4 py-3">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-line-strong/70" />
            <span className="size-2.5 rounded-full bg-line-strong/70" />
            <span className="size-2.5 rounded-full bg-line-strong/70" />
          </span>
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
            <Bot className="size-4 text-muted" />
            {t("visual.agent")}
          </span>
          <span className="ml-auto">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={done ? "done" : "running"}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className={cn(
                  "relative inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                  done ? "bg-success-soft text-success-text" : "bg-brand-soft text-brand-text",
                )}
              >
                {done ? (
                  <CircleCheck className="size-3.5" />
                ) : (
                  <span className="relative inline-flex size-2">
                    {running ? (
                      <span className="absolute inset-0 animate-breathe rounded-full bg-brand" />
                    ) : null}
                    <span className="relative size-2 rounded-full bg-brand" />
                  </span>
                )}
                {done ? t("visual.succeeded") : t("visual.running")}
              </motion.span>
            </AnimatePresence>
          </span>
        </div>

        {/* Counters */}
        <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
          <div className="px-4 py-3">
            <p className="text-[11px] text-muted">{t("visual.duration")}</p>
            <p className="text-base font-semibold whitespace-nowrap text-ink sm:text-lg">
              <Rolling to={1.8} active={step > 0} format={(v) => `${v.toFixed(1)} s`} />
            </p>
          </div>
          <div className="px-4 py-3">
            <p className="text-[11px] text-muted">{t("visual.tokens")}</p>
            <p className="text-base font-semibold whitespace-nowrap text-ink sm:text-lg">
              <Rolling to={450} active={step > 1} format={(v) => Math.round(v).toLocaleString()} />
            </p>
          </div>
          <div className="px-4 py-3">
            <p className="text-[11px] text-muted">{t("visual.cost")}</p>
            <p className="text-base font-semibold whitespace-nowrap text-ink sm:text-lg">
              {step > 3 ? "≈ $0.0002" : <span className="text-muted">—</span>}
            </p>
          </div>
        </div>

        {/* Trace */}
        <ol className="relative flex min-h-[19rem] flex-col gap-2.5 px-5 py-5 before:absolute before:top-7 before:bottom-7 before:left-[33px] before:w-px before:bg-line sm:min-h-[20.5rem]">
          {STEPS.map((item, index) => {
            const shown = index < step;
            const current = index === step - 1 && running;
            return (
              <motion.li
                key={item.key}
                initial={false}
                animate={
                  shown ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.98 }
                }
                transition={{ duration: reduced ? 0 : 0.35, ease: [0.2, 0, 0, 1] }}
                className="relative flex items-start gap-3"
              >
                <span
                  className={cn(
                    "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-surface",
                    item.tone,
                  )}
                >
                  {current ? (
                    <span className="absolute inset-0 animate-breathe rounded-full bg-brand" />
                  ) : null}
                  <item.Icon className="relative size-3.5" />
                </span>
                <div className="min-w-0 flex-1 rounded-card border border-line bg-surface px-3 py-2 shadow-sm">
                  <p className="text-[13px] font-medium text-ink">
                    {t(`visual.steps.${item.key}`)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {item.key === "answer" ? (
                      <TypedText text={t("visual.steps.answerDetail")} active={shown} />
                    ) : (
                      t(`visual.steps.${item.key}Detail`)
                    )}
                  </p>
                </div>
              </motion.li>
            );
          })}
        </ol>
      </motion.div>
    </div>
  );
}
