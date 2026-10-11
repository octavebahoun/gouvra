import { BookOpen, ChevronsLeft, ChevronsRight } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { cn } from "@/lib/cn";
import { spring } from "@/components/motion/presets";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Tooltip } from "@/components/ui/menu";
import { NAV_GROUPS } from "./nav-items";
import { ThemeToggle } from "./shell-parts";
import type { ReactNode } from "react";

type SidebarProps = {
  basePath: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  workspaceSwitcher: ReactNode;
  footer: ReactNode;
  /** Layout id for the active-item pill (distinct per sidebar instance). */
  pillId?: string;
};

/** Main navigation: the active item is marked by a pill that glides between items. */
export function Sidebar({
  basePath,
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
  workspaceSwitcher,
  footer,
  pillId = "nav-pill",
}: SidebarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col gap-3 bg-surface">
      <div className={cn("flex h-14 items-center px-4", collapsed && "justify-center px-0")}>
        <NavLink
          to={`${basePath}/overview`}
          onClick={onNavigate}
          aria-label={t("app.name")}
          className="rounded-field"
        >
          {collapsed ? <LogoMark /> : <Logo />}
        </NavLink>
      </div>
      <div className={cn("px-3", collapsed && "px-2")}>{workspaceSwitcher}</div>
      <nav
        aria-label={t("a11y.mainNavigation")}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.key} className="mt-4 first:mt-1">
            {group.key !== "main" && !collapsed ? (
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
                {t(`nav.${group.key}`)}
              </p>
            ) : null}
            {group.key !== "main" && collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-line" />
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map(({ key, path, Icon }) => {
                const label = t(`nav.${key}`);
                const link = (
                  <NavLink
                    to={`${basePath}/${path}`}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex h-9 items-center gap-3 rounded-field px-2.5 text-sm font-medium transition-colors max-md:h-10",
                        isActive
                          ? "text-brand-text"
                          : "text-muted hover:bg-surface-2 hover:text-ink",
                        collapsed && "justify-center px-0",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? (
                          <motion.span
                            layoutId={pillId}
                            transition={spring.layout}
                            className="absolute inset-0 rounded-field bg-brand-soft"
                          />
                        ) : null}
                        <Icon aria-hidden className="relative size-4 shrink-0" />
                        {collapsed ? (
                          <span className="sr-only">{label}</span>
                        ) : (
                          <span className="relative truncate">{label}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
                return (
                  <li key={key}>
                    {collapsed ? (
                      <Tooltip content={label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn("space-y-1 border-t border-line px-3 py-3", collapsed && "px-2")}>
        <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <a
            href="/docs"
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-3 rounded-field px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink",
              collapsed && "w-full flex-none justify-center px-0",
            )}
          >
            <BookOpen aria-hidden className="size-4" />
            {collapsed ? <span className="sr-only">{t("nav.docs")}</span> : t("nav.docs")}
          </a>
          <ThemeToggle />
        </div>
        {footer}
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("a11y.openNavigation") : t("a11y.closeNavigation")}
            className={cn(
              "flex h-8 w-full items-center gap-3 rounded-field px-2.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink",
              collapsed && "justify-center px-0",
            )}
          >
            {collapsed ? (
              <ChevronsRight aria-hidden className="size-4" />
            ) : (
              <ChevronsLeft aria-hidden className="size-4" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
