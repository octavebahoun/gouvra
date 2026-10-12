import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { GitHubIcon } from "@/components/brand/brand-icons";
import { Logo } from "@/components/brand/logo";
import { AnimatedOutlet } from "@/components/layout/app-shell";
import { LanguageMenu } from "@/components/layout/language-menu";
import { ConnectionBanner, ThemeToggle } from "@/components/layout/shell-parts";
import { ControlRoomVisual } from "./components/control-room-visual";
import { REPOSITORY_URL } from "@/lib/links";

/**
 * Sign-in, sign-up, recovery and e-mail link screens. Desktop: the form column next to the
 * "control room" panel. Tablet and mobile: a single, centred column.
 */
export function AuthLayout() {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  return (
    <div className="min-h-dvh bg-surface lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <a
        href="#main"
        className="sr-only z-[60] rounded-field bg-brand px-3 py-2 text-on-solid focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {tc("a11y.skipToContent")}
      </a>
      <div className="flex min-h-dvh min-w-0 flex-col">
        <ConnectionBanner />
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 px-5 sm:px-8">
          <Link to="/" aria-label={t("layout.home")} className="rounded-field">
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <LanguageMenu />
            <ThemeToggle />
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 flex-col justify-center px-5 py-8 outline-none sm:px-8 sm:py-12"
        >
          <div className="mx-auto w-full max-w-[400px]">
            <AnimatedOutlet depth={1} />
          </div>
        </main>
        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-5 text-xs text-muted sm:px-8">
          <span>{t("layout.footer")}</span>
          <nav aria-label={t("layout.footerNav")} className="flex items-center gap-4">
            <a href="/api/docs" className="rounded-sm hover:text-ink hover:underline">
              {t("layout.apiDocs")}
            </a>
            <a
              href={REPOSITORY_URL}
              className="inline-flex items-center gap-1.5 rounded-sm hover:text-ink hover:underline"
            >
              <GitHubIcon className="size-3.5" />
              {t("layout.github")}
            </a>
          </nav>
        </footer>
      </div>
      <aside
        aria-label={t("layout.asideLabel")}
        className="sticky top-0 hidden h-dvh p-3 pl-0 lg:block"
      >
        <ControlRoomVisual />
      </aside>
    </div>
  );
}
