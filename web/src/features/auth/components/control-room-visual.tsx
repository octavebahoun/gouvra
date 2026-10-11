import { Bot, CircleCheck, Gauge, ShieldCheck, Sparkles, Waypoints, Wrench } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionStatus } from "@/components/ui/badge";

/**
 * The sign-in "control room": a calm, living diagram of an agent run — a dial echoing the
 * Gouvra mark, an agent dispatching a model call and a tool call, and a trace lighting up step by
 * step. Drawn with design tokens only (adapts to dark mode); every loop is slow, transform /
 * opacity based, and stops with prefers-reduced-motion. Purely decorative: hidden from
 * assistive technologies, except the short value proposition above it.
 */
export function ControlRoomVisual() {
  const { t } = useTranslation("auth");
  const points = [
    { key: "build", Icon: Waypoints },
    { key: "run", Icon: Gauge },
    { key: "govern", Icon: ShieldCheck },
  ] as const;
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-panel border border-line bg-sunken">
      <Backdrop />
      <div className="relative z-10 px-10 pt-12 xl:px-14 xl:pt-14">
        <p className="text-xs font-semibold tracking-[0.14em] text-brand-text uppercase">
          {t("layout.eyebrow")}
        </p>
        <p className="mt-3 max-w-md text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-balance text-ink xl:text-[32px]">
          {t("layout.headline")}
        </p>
        <ul className="mt-6 space-y-2.5">
          {points.map(({ key, Icon }) => (
            <li key={key} className="flex items-center gap-3 text-sm text-muted">
              <span className="inline-flex size-7 items-center justify-center rounded-field border border-line bg-surface text-brand-text shadow-sm">
                <Icon aria-hidden className="size-3.5" />
              </span>
              {t(`layout.points.${key}`)}
            </li>
          ))}
        </ul>
      </div>
      <div
        aria-hidden
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-8 pt-4 pb-8 xl:px-12"
      >
        <Board />
      </div>
    </div>
  );
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 [background-image:radial-gradient(var(--gv-line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_70%_60%_at_60%_62%,black,transparent)] [background-size:22px_22px]" />
      <div className="absolute -top-40 -right-32 size-[560px] animate-[gv-drift_22s_ease-in-out_infinite] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_18%,transparent),transparent)]" />
      <div className="absolute -bottom-48 -left-32 size-[520px] animate-[gv-drift_28s_ease-in-out_infinite_reverse] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-chart-2)_12%,transparent),transparent)]" />
    </div>
  );
}

const CYCLE: ExecutionStatus[] = ["queued", "running", "running", "succeeded", "succeeded"];

/** Cycles the agent's status like a live run; frozen on "succeeded" with reduced motion. */
function useCyclingStatus(): ExecutionStatus {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % CYCLE.length), 1800);
    return () => window.clearInterval(timer);
  }, [reduced]);
  return reduced ? "succeeded" : (CYCLE[index] ?? "running");
}

const STATUS_STYLE: Record<ExecutionStatus, { pill: string; dot: string; text: string }> = {
  queued: { pill: "fill-neutral-soft", dot: "fill-line-strong", text: "fill-muted" },
  running: { pill: "fill-brand-soft", dot: "fill-brand", text: "fill-brand-text" },
  succeeded: { pill: "fill-success-soft", dot: "fill-success", text: "fill-success-text" },
  failed: { pill: "fill-danger-soft", dot: "fill-danger", text: "fill-danger-text" },
  cancelled: { pill: "fill-neutral-soft", dot: "fill-line-strong", text: "fill-muted" },
  timed_out: { pill: "fill-danger-soft", dot: "fill-danger", text: "fill-danger-text" },
};

const CARD_SHADOW: CSSProperties = {
  filter: "drop-shadow(0 10px 18px color-mix(in srgb, var(--gv-ink) 10%, transparent))",
};

/** Paths from the agent to each step (also used by the travelling packets). */
const LINKS = {
  model: "M 202 176 C 250 176, 250 78, 296 78",
  tool: "M 202 196 C 254 196, 268 196, 316 196",
  result: "M 202 216 C 250 216, 250 314, 296 314",
};

function Card({
  x,
  y,
  width,
  height,
  delay,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  delay: number;
  children: ReactNode;
}) {
  return (
    <g
      className="animate-float"
      style={{ animationDelay: `${delay}s`, transformBox: "fill-box", transformOrigin: "center" }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={12}
        className="fill-surface stroke-line"
        strokeWidth={1}
        style={CARD_SHADOW}
      />
      {children}
    </g>
  );
}

function IconTile({
  x,
  y,
  tone,
  children,
}: {
  x: number;
  y: number;
  tone: "brand" | "success" | "warning";
  children: ReactNode;
}) {
  const fill = {
    brand: "fill-brand-soft",
    success: "fill-success-soft",
    warning: "fill-warning-soft",
  }[tone];
  return (
    <g>
      <rect x={x} y={y} width={30} height={30} rx={8} className={fill} />
      <g transform={`translate(${x + 7} ${y + 7})`}>{children}</g>
    </g>
  );
}

function Bar({
  x,
  y,
  width,
  tone = "soft",
}: {
  x: number;
  y: number;
  width: number;
  tone?: "soft" | "line";
}) {
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={6}
      rx={3}
      className={tone === "soft" ? "fill-surface-2" : "fill-line"}
    />
  );
}

function Board() {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  const status = useCyclingStatus();
  const style = STATUS_STYLE[status];
  const statusLabel = tc(`status.${status}`);

  return (
    <svg
      viewBox="0 0 520 420"
      className="h-full max-h-[440px] w-full max-w-[560px] overflow-visible font-sans"
      role="presentation"
    >
      {/* Dial: the Gouvra mark, drawn large and faint behind the run */}
      <g transform="translate(260 196)">
        <circle
          r={182}
          className="animate-[spin_90s_linear_infinite] fill-none stroke-line-strong/40"
          strokeWidth={1}
          strokeDasharray="2 7"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
        <circle r={132} className="fill-none stroke-line" strokeWidth={1} />
        {Array.from({ length: 24 }, (_, i) => {
          const angle = (i * Math.PI) / 12;
          const major = i % 6 === 0;
          const inner = major ? 188 : 192;
          return (
            <line
              key={i}
              x1={Math.cos(angle) * inner}
              y1={Math.sin(angle) * inner}
              x2={Math.cos(angle) * 198}
              y2={Math.sin(angle) * 198}
              className={major ? "stroke-brand/60" : "stroke-line-strong/40"}
              strokeWidth={major ? 2 : 1}
              strokeLinecap="round"
            />
          );
        })}
        <path
          d="M 64 -64 A 90.5 90.5 0 1 0 90.5 0"
          className="fill-none stroke-brand/15"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d="M 90.5 0 H 24"
          className="stroke-brand/15"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <circle r={12} className="fill-brand/20" />
      </g>

      {/* Links agent → steps, with packets travelling along them */}
      {Object.entries(LINKS).map(([key, d], i) => (
        <g key={key}>
          <path
            d={d}
            className="animate-dash fill-none stroke-line-strong/70"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
          <circle
            r={3.5}
            className="fill-brand motion-reduce:hidden"
            style={{
              offsetPath: `path("${d}")`,
              offsetRotate: "0deg",
              opacity: 0,
              animation: `gv-travel 3.6s ${i * 1.2}s cubic-bezier(0.2, 0, 0, 1) infinite`,
            }}
          />
        </g>
      ))}

      {/* Agent */}
      <Card x={26} y={138} width={176} height={116} delay={0}>
        <IconTile x={42} y={154} tone="brand">
          <Bot width={16} height={16} className="stroke-brand-text" />
        </IconTile>
        <text x={82} y={174} className="fill-ink text-[13px] font-semibold">
          {t("layout.board.agent")}
        </text>
        <Bar x={82} y={182} width={70} />
        <Bar x={42} y={202} width={140} />
        <g>
          <rect x={42} y={220} width={96} height={22} rx={11} className={style.pill} />
          <circle cx={54} cy={231} r={3.5} className={style.dot}>
            {status === "running" ? (
              <animate
                attributeName="opacity"
                values="1;0.35;1"
                dur="1.2s"
                repeatCount="indefinite"
              />
            ) : null}
          </circle>
          <text x={63} y={235} className={`${style.text} text-[11px] font-medium`}>
            {statusLabel}
          </text>
        </g>
      </Card>

      {/* Model call: tokens streaming */}
      <Card x={296} y={42} width={198} height={72} delay={0.8}>
        <IconTile x={310} y={56} tone="brand">
          <Sparkles width={16} height={16} className="stroke-brand-text" />
        </IconTile>
        <text x={350} y={74} className="fill-ink text-[12.5px] font-semibold">
          {t("layout.board.model")}
        </text>
        <rect x={350} y={86} width={128} height={6} rx={3} className="fill-surface-2" />
        <rect
          x={350}
          y={86}
          width={128}
          height={6}
          rx={3}
          className="animate-[gv-stream_3.6s_cubic-bezier(0.2,0,0,1)_infinite] fill-brand/70"
          style={{ transformBox: "fill-box", transformOrigin: "left center" }}
        />
      </Card>

      {/* Tool call */}
      <Card x={316} y={160} width={178} height={72} delay={1.6}>
        <IconTile x={330} y={174} tone="warning">
          <Wrench width={16} height={16} className="stroke-warning-text" />
        </IconTile>
        <text x={370} y={192} className="fill-ink text-[12.5px] font-semibold">
          {t("layout.board.tool")}
        </text>
        <Bar x={370} y={204} width={74} />
        <g transform="translate(456 196)">
          <CircleCheck width={18} height={18} className="stroke-success" />
        </g>
      </Card>

      {/* Result */}
      <Card x={296} y={278} width={198} height={72} delay={2.4}>
        <IconTile x={310} y={292} tone="success">
          <CircleCheck width={16} height={16} className="stroke-success-text" />
        </IconTile>
        <text x={350} y={310} className="fill-ink text-[12.5px] font-semibold">
          {t("layout.board.result")}
        </text>
        <Bar x={350} y={320} width={124} />
        <Bar x={350} y={332} width={84} />
      </Card>

      {/* Trace: steps light up one after another */}
      <g transform="translate(26 384)">
        <text
          x={0}
          y={4}
          className="fill-muted text-[11px] font-semibold tracking-[0.12em] uppercase"
        >
          {t("layout.board.trace")}
        </text>
        <line
          x1={64}
          y1={0}
          x2={468}
          y2={0}
          className="stroke-line"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {[0, 1, 2, 3, 4].map((i) => (
          <circle
            key={i}
            cx={84 + i * 96}
            cy={0}
            r={6}
            className={i === 4 ? "fill-success" : "fill-brand"}
            style={{
              transformBox: "fill-box",
              transformOrigin: "center",
              animation: `gv-trace-step 6s ${i * 0.5}s ease-in-out infinite`,
            }}
          />
        ))}
      </g>
    </svg>
  );
}
