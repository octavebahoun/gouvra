import { motion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "@/lib/cn";
import { spring } from "@/components/motion/presets";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

type TabItem = { value: string; label: ReactNode; count?: number };

/** Tab list with an indicator that glides to the active tab. */
export function TabsList({
  items,
  value,
  className,
  ...props
}: { items: TabItem[]; value: string } & Omit<
  ComponentProps<typeof TabsPrimitive.List>,
  "children"
>) {
  const layoutId = useId();
  return (
    <TabsPrimitive.List
      className={cn("relative flex gap-1 overflow-x-auto border-b border-line", className)}
      {...props}
    >
      {items.map((item) => (
        <TabsPrimitive.Trigger
          key={item.value}
          value={item.value}
          className={cn(
            "relative inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium text-muted transition-colors",
            "hover:text-ink data-[state=active]:text-ink",
          )}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted tabular-nums">
              {item.count}
            </span>
          ) : null}
          {value === item.value ? (
            <motion.span
              layoutId={layoutId}
              transition={spring.layout}
              className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-brand"
            />
          ) : null}
        </TabsPrimitive.Trigger>
      ))}
    </TabsPrimitive.List>
  );
}

type TabLinkItem = { to: string; label: ReactNode; count?: number; end?: boolean };

/**
 * Route-based sections that look like tabs (e.g. settings). They are links — each section has
 * its own URL — so they are marked up as navigation with `aria-current`, not as ARIA tabs.
 */
export function TabLinks({
  items,
  label,
  className,
}: {
  items: TabLinkItem[];
  label: string;
  className?: string;
}) {
  const layoutId = useId();
  return (
    <nav aria-label={label} className={cn("relative border-b border-line", className)}>
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li key={item.to} className="shrink-0">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "relative inline-flex h-10 items-center gap-2 rounded-t-field px-3 text-sm font-medium transition-colors max-md:h-11 max-sm:px-2.5",
                  isActive ? "text-ink" : "text-muted hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {item.label}
                  {item.count !== undefined ? (
                    <span className="hidden rounded-full bg-surface-2 px-1.5 text-xs text-muted tabular-nums sm:inline">
                      {item.count}
                    </span>
                  ) : null}
                  {isActive ? (
                    <motion.span
                      layoutId={layoutId}
                      transition={spring.layout}
                      className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand"
                    />
                  ) : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
