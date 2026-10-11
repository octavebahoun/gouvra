import { cn } from "@/lib/cn";

/**
 * Original empty-state illustrations. Drawn with design tokens (adapt to dark mode) and
 * lightly animated (floating nodes, flowing links) — the animation stops with reduced motion.
 */
export type IllustrationName =
  | "empty"
  | "agents"
  | "executions"
  | "tools"
  | "providers"
  | "evaluations"
  | "workflows"
  | "usage"
  | "error"
  | "locked"
  | "not-found"
  | "automations"
  | "members";

const stroke = { stroke: "var(--gv-line-strong)", strokeWidth: 1.5, fill: "none" } as const;

function Base({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 160 112" aria-hidden className={cn("overflow-visible", className)}>
      <ellipse cx="80" cy="102" rx="54" ry="6" fill="var(--gv-surface-2)" />
      {children}
    </svg>
  );
}

function Node({
  x,
  y,
  r = 9,
  tone = "brand",
  delay = 0,
}: {
  x: number;
  y: number;
  r?: number;
  tone?: "brand" | "muted" | "success" | "danger";
  delay?: number;
}) {
  const fill = {
    brand: "var(--gv-brand-soft)",
    muted: "var(--gv-surface)",
    success: "var(--gv-success-soft)",
    danger: "var(--gv-danger-soft)",
  }[tone];
  const ring = {
    brand: "var(--gv-brand)",
    muted: "var(--gv-line-strong)",
    success: "var(--gv-success)",
    danger: "var(--gv-danger)",
  }[tone];
  return (
    <g
      className="animate-float"
      style={{ animationDelay: `${delay}s`, transformBox: "fill-box", transformOrigin: "center" }}
    >
      <circle cx={x} cy={y} r={r} fill={fill} stroke={ring} strokeWidth={1.5} />
      <circle cx={x} cy={y} r={r / 3} fill={ring} />
    </g>
  );
}

function Link({ d }: { d: string }) {
  return <path d={d} {...stroke} strokeDasharray="4 4" className="animate-dash" />;
}

function Panel({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill="var(--gv-surface)"
        stroke="var(--gv-line)"
        strokeWidth={1.5}
      />
      <rect x={x + 8} y={y + 9} width={w * 0.45} height={4} rx={2} fill="var(--gv-line)" />
      <rect x={x + 8} y={y + 18} width={w * 0.7} height={4} rx={2} fill="var(--gv-surface-2)" />
    </g>
  );
}

export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  switch (name) {
    case "agents":
      return (
        <Base className={className}>
          <Link d="M48 52 C64 30, 96 30, 112 52" />
          <Link d="M48 58 C64 80, 96 80, 112 58" />
          <rect
            x="62"
            y="34"
            width="36"
            height="40"
            rx="12"
            fill="var(--gv-surface)"
            stroke="var(--gv-brand)"
            strokeWidth={1.5}
          />
          <circle cx="74" cy="52" r="3" fill="var(--gv-brand)" />
          <circle cx="86" cy="52" r="3" fill="var(--gv-brand)" />
          <path d="M73 63 h14" stroke="var(--gv-brand)" strokeWidth={1.5} strokeLinecap="round" />
          <path d="M80 34 v-8" stroke="var(--gv-brand)" strokeWidth={1.5} />
          <Node x={80} y={22} r={5} />
          <Node x={40} y={55} r={8} tone="muted" delay={0.6} />
          <Node x={120} y={55} r={8} tone="muted" delay={1.2} />
        </Base>
      );
    case "executions":
      return (
        <Base className={className}>
          <path d="M34 26 V90" {...stroke} />
          {[30, 52, 74].map((y, i) => (
            <g key={y}>
              <Node x={34} y={y} r={6} tone={i === 2 ? "brand" : "success"} delay={i * 0.4} />
              <rect
                x={48}
                y={y - 8}
                width={78 - i * 12}
                height={16}
                rx={6}
                fill="var(--gv-surface)"
                stroke="var(--gv-line)"
                strokeWidth={1.5}
              />
              <rect x={55} y={y - 2} width={36 - i * 6} height={4} rx={2} fill="var(--gv-line)" />
            </g>
          ))}
          <circle cx={34} cy={92} r={3} fill="var(--gv-line-strong)" />
        </Base>
      );
    case "tools":
      return (
        <Base className={className}>
          <Panel x={30} y={28} w={56} h={34} />
          <Panel x={74} y={50} w={56} h={34} />
          <Link d="M86 45 C100 45, 104 50, 104 50" />
          <path
            d="M112 22 l8 8 -16 16 -8 -8 z"
            fill="var(--gv-brand-soft)"
            stroke="var(--gv-brand)"
            strokeWidth={1.5}
            className="animate-float"
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
        </Base>
      );
    case "providers":
      return (
        <Base className={className}>
          <Link d="M44 56 H116" />
          <rect
            x="24"
            y="40"
            width="34"
            height="32"
            rx="9"
            fill="var(--gv-surface)"
            stroke="var(--gv-line-strong)"
            strokeWidth={1.5}
          />
          <path
            d="M33 50 v-6 M49 50 v-6"
            stroke="var(--gv-line-strong)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <rect
            x="102"
            y="40"
            width="34"
            height="32"
            rx="9"
            fill="var(--gv-brand-soft)"
            stroke="var(--gv-brand)"
            strokeWidth={1.5}
          />
          <Node x={80} y={56} r={6} delay={0.3} />
        </Base>
      );
    case "evaluations":
      return (
        <Base className={className}>
          <Panel x={36} y={24} w={88} h={64} />
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect
                x={46}
                y={50 + i * 11}
                width={50}
                height={5}
                rx={2.5}
                fill="var(--gv-surface-2)"
              />
              <rect
                x={46}
                y={50 + i * 11}
                width={[44, 30, 38][i]}
                height={5}
                rx={2.5}
                fill={i === 1 ? "var(--gv-warning)" : "var(--gv-success)"}
                opacity={0.75}
              />
            </g>
          ))}
          <Node x={110} y={60} r={8} tone="success" />
        </Base>
      );
    case "workflows":
      return (
        <Base className={className}>
          <Link d="M44 40 C64 40, 60 30, 80 30" />
          <Link d="M44 40 C64 40, 60 76, 80 76" />
          <Link d="M96 30 C112 30, 108 54, 120 54" />
          <Link d="M96 76 C112 76, 108 54, 120 54" />
          <Node x={36} y={40} r={8} />
          <Node x={88} y={30} r={8} tone="muted" delay={0.4} />
          <Node x={88} y={76} r={8} tone="muted" delay={0.8} />
          <Node x={124} y={54} r={8} tone="success" delay={1.2} />
        </Base>
      );
    case "usage":
      return (
        <Base className={className}>
          <path d="M30 88 H130" {...stroke} />
          {[18, 32, 26, 44, 38, 56].map((h, i) => (
            <rect
              key={i}
              x={36 + i * 15}
              y={88 - h}
              width={9}
              height={h}
              rx={3}
              fill={i === 5 ? "var(--gv-brand)" : "var(--gv-line)"}
            />
          ))}
          <path
            d="M40 66 L55 58 L70 62 L85 46 L100 50 L115 34"
            fill="none"
            stroke="var(--gv-brand)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            className="animate-dash"
          />
        </Base>
      );
    case "automations":
      return (
        <Base className={className}>
          <circle
            cx="80"
            cy="54"
            r="30"
            fill="var(--gv-surface)"
            stroke="var(--gv-line-strong)"
            strokeWidth={1.5}
          />
          <path
            d="M80 54 V36 M80 54 L94 62"
            stroke="var(--gv-brand)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle
            cx="80"
            cy="54"
            r="34"
            fill="none"
            stroke="var(--gv-brand)"
            strokeWidth={1.5}
            strokeDasharray="4 6"
            className="animate-spin-slow"
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
        </Base>
      );
    case "members":
      return (
        <Base className={className}>
          {[50, 80, 110].map((x, i) => (
            <g
              key={x}
              className="animate-float"
              style={{
                animationDelay: `${i * 0.4}s`,
                transformBox: "fill-box",
                transformOrigin: "center",
              }}
            >
              <circle
                cx={x}
                cy={46}
                r={11}
                fill={i === 1 ? "var(--gv-brand-soft)" : "var(--gv-surface)"}
                stroke={i === 1 ? "var(--gv-brand)" : "var(--gv-line-strong)"}
                strokeWidth={1.5}
              />
              <path
                d={`M${x - 16} 82 a16 14 0 0 1 32 0`}
                fill={i === 1 ? "var(--gv-brand-soft)" : "var(--gv-surface)"}
                stroke={i === 1 ? "var(--gv-brand)" : "var(--gv-line-strong)"}
                strokeWidth={1.5}
              />
            </g>
          ))}
        </Base>
      );
    case "error":
      return (
        <Base className={className}>
          <Link d="M40 56 H68" />
          <Link d="M92 56 H120" />
          <Node x={36} y={56} r={8} tone="muted" />
          <Node x={124} y={56} r={8} tone="muted" delay={0.5} />
          <circle
            cx="80"
            cy="56"
            r="14"
            fill="var(--gv-danger-soft)"
            stroke="var(--gv-danger)"
            strokeWidth={1.5}
          />
          <path
            d="M80 49 v8 M80 62 v0.5"
            stroke="var(--gv-danger)"
            strokeWidth={2.2}
            strokeLinecap="round"
          />
        </Base>
      );
    case "locked":
      return (
        <Base className={className}>
          <rect
            x="58"
            y="48"
            width="44"
            height="38"
            rx="9"
            fill="var(--gv-surface)"
            stroke="var(--gv-line-strong)"
            strokeWidth={1.5}
          />
          <path
            d="M67 48 v-8 a13 13 0 0 1 26 0 v8"
            fill="none"
            stroke="var(--gv-line-strong)"
            strokeWidth={1.5}
          />
          <circle cx="80" cy="64" r="4" fill="var(--gv-brand)" />
          <path d="M80 67 v7" stroke="var(--gv-brand)" strokeWidth={2} strokeLinecap="round" />
        </Base>
      );
    case "not-found":
      return (
        <Base className={className}>
          <circle
            cx="72"
            cy="50"
            r="22"
            fill="var(--gv-surface)"
            stroke="var(--gv-line-strong)"
            strokeWidth={1.5}
          />
          <path
            d="M88 66 L108 86"
            stroke="var(--gv-line-strong)"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <path
            d="M64 46 q8 -8 16 0"
            stroke="var(--gv-muted)"
            strokeWidth={1.5}
            fill="none"
            strokeLinecap="round"
          />
          <Node x={120} y={30} r={5} tone="muted" delay={0.6} />
        </Base>
      );
    default:
      return (
        <Base className={className}>
          <Panel x={40} y={30} w={80} h={56} />
          <Node x={120} y={30} r={7} delay={0.4} />
          <Link d="M40 92 H120" />
        </Base>
      );
  }
}
