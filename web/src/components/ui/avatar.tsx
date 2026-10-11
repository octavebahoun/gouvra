import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-5 text-[10px]",
  sm: "size-7 text-[11px]",
  md: "size-9 text-sm",
  lg: "size-14 text-lg",
};
const HUES = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

function hueFor(name: string): (typeof HUES)[number] {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length] ?? "chart-1";
}

/** Initials avatar with a stable colour per name (decorative: the name is always shown nearby). */
export function Avatar({
  name,
  size = "md",
  square = false,
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  square?: boolean;
  className?: string;
}) {
  const hue = hueFor(name);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold text-on-solid select-none",
        square ? "rounded-[7px]" : "rounded-full",
        SIZES[size],
        className,
      )}
      style={{
        background: `linear-gradient(135deg, var(--gv-${hue}), color-mix(in srgb, var(--gv-${hue}) 70%, #0b111c))`,
      }}
    >
      {initials(name)}
    </span>
  );
}
