import { Menu as MenuIcon, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useOutlet } from "react-router";
import { duration, ease } from "@/components/motion/presets";
import { LogoMark } from "@/components/brand/logo";
import { ConnectionBanner, ThemeToggle } from "./shell-parts";
import { Sidebar } from "./sidebar";

const COLLAPSE_KEY = "gouvra.sidebar.collapsed";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Route content with a short cross-fade; keyed by section so tabs inside a page don't re-animate. */
export function AnimatedOutlet({ depth = 3 }: { depth?: number }) {
  const location = useLocation();
  const outlet = useOutlet();
  const key = location.pathname
    .split("/")
    .slice(0, depth + 1)
    .join("/");
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.standard } }}
        exit={{ opacity: 0, transition: { duration: 0.1, ease: ease.exit } }}
        className="min-h-full"
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  );
}

type AppShellProps = {
  basePath: string;
  workspaceSwitcher: (collapsed: boolean) => ReactNode;
  userMenu: (collapsed: boolean) => ReactNode;
  children: ReactNode;
};

/**
 * Desktop ≥1200: full sidebar. Tablet 768–1199: collapsible icon rail.
 * Mobile <768: top bar + navigation drawer (focus trapped, Escape closes).
 */
export function AppShell({ basePath, workspaceSwitcher, userMenu, children }: AppShellProps) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isTablet = useMediaQuery("(min-width: 768px) and (max-width: 1199px)");
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      return saved === null ? null : saved === "1";
    } catch {
      return null;
    }
  });
  const collapsed = userCollapsed ?? isTablet;
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setUserCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-[60] rounded-field bg-brand px-3 py-2 text-on-solid focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("a11y.skipToContent")}
      </a>

      {!isMobile ? (
        <motion.aside
          animate={{ width: collapsed ? 68 : 252 }}
          transition={{ duration: duration.slow, ease: ease.standard }}
          className="sticky top-0 hidden h-dvh shrink-0 border-r border-line md:block"
        >
          <Sidebar
            basePath={basePath}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            workspaceSwitcher={workspaceSwitcher(collapsed)}
            footer={userMenu(collapsed)}
          />
        </motion.aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {isMobile ? (
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur">
            <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DialogPrimitive.Trigger asChild>
                <button
                  type="button"
                  aria-label={t("a11y.openNavigation")}
                  className="inline-flex size-10 items-center justify-center rounded-field text-ink hover:bg-surface-2"
                >
                  <MenuIcon aria-hidden className="size-5" />
                </button>
              </DialogPrimitive.Trigger>
              <AnimatePresence>
                {drawerOpen ? (
                  <DialogPrimitive.Portal forceMount>
                    <DialogPrimitive.Overlay asChild forceMount>
                      <motion.div
                        className="fixed inset-0 z-40 bg-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      />
                    </DialogPrimitive.Overlay>
                    <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                      <motion.div
                        className="fixed inset-y-0 left-0 z-50 w-[min(84vw,300px)] border-r border-line shadow-lg"
                        initial={{ x: "-100%" }}
                        animate={{
                          x: 0,
                          transition: { duration: duration.slow, ease: ease.standard },
                        }}
                        exit={{
                          x: "-100%",
                          transition: { duration: duration.base, ease: ease.exit },
                        }}
                      >
                        <DialogPrimitive.Title className="sr-only">
                          {t("a11y.mainNavigation")}
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Close asChild>
                          <button
                            type="button"
                            aria-label={t("a11y.closeNavigation")}
                            className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-field text-muted hover:bg-surface-2"
                          >
                            <X aria-hidden className="size-4" />
                          </button>
                        </DialogPrimitive.Close>
                        <Sidebar
                          basePath={basePath}
                          pillId="nav-pill-mobile"
                          onNavigate={() => setDrawerOpen(false)}
                          workspaceSwitcher={workspaceSwitcher(false)}
                          footer={userMenu(false)}
                        />
                      </motion.div>
                    </DialogPrimitive.Content>
                  </DialogPrimitive.Portal>
                ) : null}
              </AnimatePresence>
            </DialogPrimitive.Root>
            <LogoMark className="size-6" />
            <span className="font-semibold tracking-tight">gouvra</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
        ) : null}
        <ConnectionBanner />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
