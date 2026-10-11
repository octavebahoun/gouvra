import { ArrowRight } from "lucide-react";
import { GitHubIcon } from "@/components/brand/brand-icons";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/shell-parts";
import { fadeUp, staggerChildren } from "@/components/motion/presets";

/** Public site (screen A). The full animated hero lands in phase 5. */
export function LandingPage() {
  const { t } = useTranslation();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1" aria-label={t("a11y.mainNavigation")}>
          <ThemeToggle />
          <Button asChild variant="tertiary" size="sm">
            <a href="/api/docs">{t("nav.docs")}</a>
          </Button>
        </nav>
      </header>
      <motion.main
        id="main"
        variants={staggerChildren(0.08, 0.1)}
        initial="hidden"
        animate="visible"
        className="mx-auto flex max-w-3xl flex-col items-center px-4 pt-24 pb-32 text-center sm:px-6"
      >
        <motion.p
          variants={fadeUp}
          className="mb-4 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted"
        >
          {t("footer.license")}
        </motion.p>
        <motion.h1
          variants={fadeUp}
          className="text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-5xl"
        >
          {t("app.tagline")}
        </motion.h1>
        <motion.div variants={fadeUp} className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" rightIcon={<ArrowRight aria-hidden />}>
            <Link to="/design-system">Design system</Link>
          </Button>
          <Button asChild size="lg" variant="secondary" leftIcon={<GitHubIcon />}>
            <a href="https://github.com/gouvra/gouvra">GitHub</a>
          </Button>
        </motion.div>
      </motion.main>
    </div>
  );
}
