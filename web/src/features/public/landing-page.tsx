import {
  ArrowRight,
  Boxes,
  ChartNoAxesCombined,
  Check,
  FlaskConical,
  Coins,
  ShieldCheck,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/auth/session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { GitHubIcon } from "@/components/brand/brand-icons";
import { Logo } from "@/components/brand/logo";
import { LanguageMenu } from "@/components/layout/language-menu";
import { ThemeToggle } from "@/components/layout/shell-parts";
import { ease, fadeUp, staggerChildren } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { HeroVisual } from "./hero-visual";

const GITHUB_URL = "https://github.com/gouvra/gouvra";
const VERBS = ["build", "run", "evaluate", "supervise"] as const;

/** Screen A — the public site: value proposition, capabilities, how it works, open source. */
export function LandingPage() {
  const { t } = useTranslation(["site", "common"]);
  useDocumentTitle(`${t("common:app.name")} — ${t("common:app.tagline")}`);
  return (
    <div className="min-h-dvh overflow-x-clip bg-canvas">
      <SiteHeader />
      <main id="main">
        <Hero />
        <Trust />
        <Features />
        <Steps />
        <OpenSource />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  const { t } = useTranslation(["site", "common"]);
  const session = useSession();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => scrollY.on("change", (y) => setScrolled(y > 8)), [scrollY]);
  const signedIn = Boolean(session.data);
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled ? "border-line bg-canvas/80 backdrop-blur-md" : "border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="rounded-field focus-visible:outline-2 focus-visible:outline-focus">
          <Logo />
        </Link>
        <nav aria-label={t("nav.label")} className="hidden flex-1 items-center gap-1 md:flex">
          {[
            { href: "#features", label: t("nav.features") },
            { href: "#how", label: t("nav.how") },
            { href: "#open-source", label: t("nav.openSource") },
            { href: "/api/docs", label: t("nav.docs") },
          ].map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-field px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <LanguageMenu />
          <ThemeToggle />
          {signedIn ? (
            <Button asChild size="sm" rightIcon={<ArrowRight aria-hidden />}>
              <Link to="/app">{t("nav.openApp")}</Link>
            </Button>
          ) : (
            <>
              <Button asChild size="sm" variant="tertiary" className="max-sm:hidden">
                <Link to="/login">{t("nav.signIn")}</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/register">{t("nav.getStarted")}</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/** "Build / Run / Evaluate / Supervise" — the verb rolls from below, one word at a time. */
function RollingVerb() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced) return undefined;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % VERBS.length), 2400);
    return () => window.clearInterval(timer);
  }, [reduced]);
  const verb = VERBS[index] ?? "build";
  return (
    <span className="relative inline-grid justify-items-end overflow-hidden pb-[0.12em] align-bottom">
      {/* Reserve the width of the longest verb so the line never jumps. */}
      <span className="invisible col-start-1 row-start-1">
        {VERBS.map((v) => t(`hero.verbs.${v}`)).reduce((a, b) => (b.length > a.length ? b : a))}
      </span>
      {/* Both words share the grid cell: the old one leaves upwards as the new one rises. */}
      <AnimatePresence initial={false}>
        <motion.span
          key={verb}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-100%", opacity: 0 }}
          transition={{ duration: 0.55, ease: ease.standard }}
          className="col-start-1 row-start-1 bg-gradient-to-r from-[var(--gv-brand)] to-[var(--gv-chart-4)] bg-clip-text text-transparent"
        >
          {t(`hero.verbs.${verb}`)}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Hero() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const glow = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [0, 160]);
  const fade = useTransform(scrollYProgress, [0, 0.6], [1, reduced ? 1 : 0.2]);
  return (
    <section
      ref={ref}
      aria-labelledby="hero-title"
      className="relative isolate pt-14 pb-24 sm:pt-20"
    >
      {/* Backdrop: a slow grid and a brand glow that drifts with the scroll. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--gv-line)_1px,transparent_1px),linear-gradient(to_bottom,var(--gv-line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_50%_20%,black_20%,transparent_70%)] bg-[size:48px_48px] opacity-50" />
        <motion.div
          style={{ y: glow }}
          className="absolute top-[-12rem] left-1/2 h-[36rem] w-[64rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_22%,transparent),transparent)]"
        />
      </div>
      <motion.div
        variants={staggerChildren(0.09, 0.05)}
        initial="hidden"
        animate="visible"
        style={{ opacity: fade }}
        className="mx-auto flex max-w-4xl flex-col items-center px-4 text-center sm:px-6"
      >
        <motion.p
          variants={fadeUp}
          className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-muted shadow-sm backdrop-blur"
        >
          <span className="relative inline-flex size-2">
            <span aria-hidden className="absolute inset-0 animate-breathe rounded-full bg-brand" />
            <span className="relative size-2 rounded-full bg-brand" />
          </span>
          {t("hero.eyebrow")}
        </motion.p>
        <motion.h1
          id="hero-title"
          variants={fadeUp}
          className="mt-6 text-[2.6rem] leading-[1.04] font-semibold tracking-[-0.035em] text-balance text-ink sm:text-6xl lg:text-7xl"
        >
          <span className="sr-only">{t("hero.titleSr")}</span>
          <span aria-hidden>
            <RollingVerb /> {t("hero.titleRest")}
            <br />
            <span className="text-muted">{t("hero.titleLine2")}</span>
          </span>
        </motion.h1>
        <motion.p
          variants={fadeUp}
          className="mt-6 max-w-2xl text-base leading-relaxed text-pretty text-muted sm:text-lg"
        >
          {t("hero.subtitle")}
        </motion.p>
        <motion.div variants={fadeUp} className="mt-9 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" rightIcon={<ArrowRight aria-hidden />}>
            <Link to="/register">{t("hero.primary")}</Link>
          </Button>
          <Button asChild size="lg" variant="secondary" leftIcon={<GitHubIcon />}>
            <a href={GITHUB_URL}>{t("hero.secondary")}</a>
          </Button>
        </motion.div>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : 0.9, delay: 0.35, ease: ease.standard }}
        className="mt-16 px-4 sm:px-6"
      >
        <p className="sr-only">{t("hero.visualLabel")}</p>
        <HeroVisual target={ref} />
      </motion.div>
    </section>
  );
}

function Trust() {
  const { t } = useTranslation("site");
  const names = ["DeepSeek", "Anthropic Claude", "OpenAI-compatible APIs", t("trust.offline")];
  return (
    <section aria-label={t("trust.label")} className="border-y border-line bg-surface/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-6 text-sm sm:px-6">
        <span className="text-muted">{t("trust.label")}</span>
        {names.map((name) => (
          <span key={name} className="font-medium text-ink">
            {name}
          </span>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  id,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  id: string;
}) {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.5 }}
      variants={staggerChildren(0.08)}
      className="mx-auto max-w-2xl text-center"
    >
      <motion.p
        variants={fadeUp}
        className="text-xs font-semibold tracking-[0.14em] text-brand-text uppercase"
      >
        {eyebrow}
      </motion.p>
      <motion.h2
        id={id}
        variants={fadeUp}
        className="mt-3 text-3xl font-semibold tracking-[-0.025em] text-balance text-ink sm:text-4xl"
      >
        {title}
      </motion.h2>
      {body ? (
        <motion.p
          variants={fadeUp}
          className="mt-4 text-base leading-relaxed text-pretty text-muted"
        >
          {body}
        </motion.p>
      ) : null}
    </motion.div>
  );
}

const FEATURES: {
  key: "agents" | "traces" | "tools" | "evaluations" | "costs" | "teams";
  Icon: LucideIcon;
}[] = [
  { key: "agents", Icon: Boxes },
  { key: "traces", Icon: ChartNoAxesCombined },
  { key: "tools", Icon: Wrench },
  { key: "evaluations", Icon: FlaskConical },
  { key: "costs", Icon: Coins },
  { key: "teams", Icon: Users },
];

function Features() {
  const { t } = useTranslation("site");
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="scroll-mt-20 px-4 py-24 sm:px-6"
    >
      <SectionHeading
        id="features-title"
        eyebrow={t("features.eyebrow")}
        title={t("features.title")}
        body={t("features.subtitle")}
      />
      <motion.ul
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.2 }}
        variants={staggerChildren(0.07)}
        className="mx-auto mt-14 grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {FEATURES.map(({ key, Icon }) => (
          <motion.li
            key={key}
            variants={fadeUp}
            className="group relative overflow-hidden rounded-panel border border-line bg-surface p-6 shadow-sm transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-1 hover:border-line-strong hover:shadow-lg"
          >
            <span
              aria-hidden
              className="absolute -top-16 -right-16 size-40 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_16%,transparent),transparent)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            />
            <span className="inline-flex size-10 items-center justify-center rounded-card bg-brand-soft text-brand-text transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6">
              <Icon aria-hidden className="size-5" />
            </span>
            <h3 className="mt-5 text-base font-semibold text-ink">
              {t(`features.items.${key}.title`)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t(`features.items.${key}.body`)}
            </p>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  );
}

function Steps() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const ref = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 80%", "end 60%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 28 });
  const height = useTransform(progress, [0, 1], reduced ? ["100%", "100%"] : ["0%", "100%"]);
  const items = ["connect", "build", "run"] as const;
  return (
    <section
      id="how"
      aria-labelledby="how-title"
      className="scroll-mt-20 bg-surface/50 px-4 py-24 sm:px-6"
    >
      <SectionHeading id="how-title" eyebrow={t("steps.eyebrow")} title={t("steps.title")} />
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
        {items.map((key, index) => (
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
    </section>
  );
}

function OpenSource() {
  const { t } = useTranslation("site");
  const command =
    "git clone https://github.com/gouvra/gouvra && cd gouvra && scripts/gen-secrets && docker compose up";
  const points = [
    { key: "license", Icon: ShieldCheck },
    { key: "data", Icon: Boxes },
    { key: "api", Icon: Terminal },
  ] as const;
  return (
    <section
      id="open-source"
      aria-labelledby="open-source-title"
      className="scroll-mt-20 px-4 py-24 sm:px-6"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={staggerChildren(0.08)}
        >
          <motion.p
            variants={fadeUp}
            className="text-xs font-semibold tracking-[0.14em] text-brand-text uppercase"
          >
            {t("openSource.eyebrow")}
          </motion.p>
          <motion.h2
            id="open-source-title"
            variants={fadeUp}
            className="mt-3 text-3xl font-semibold tracking-[-0.025em] text-ink sm:text-4xl"
          >
            {t("openSource.title")}
          </motion.h2>
          <motion.p variants={fadeUp} className="mt-4 text-base leading-relaxed text-muted">
            {t("openSource.body")}
          </motion.p>
          <motion.ul variants={fadeUp} className="mt-6 space-y-3">
            {points.map(({ key, Icon }) => (
              <li key={key} className="flex items-center gap-3 text-[15px] text-ink">
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-success-soft text-success-text">
                  <Check aria-hidden className="size-4" />
                </span>
                {t(`openSource.points.${key}`)}
                <Icon aria-hidden className="ml-auto size-4 text-muted" />
              </li>
            ))}
          </motion.ul>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: ease.standard }}
          className="overflow-hidden rounded-panel border border-line bg-terminal shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b border-terminal-line px-4 py-3">
            <span className="size-2.5 rounded-full bg-terminal-line" />
            <span className="size-2.5 rounded-full bg-terminal-line" />
            <span className="size-2.5 rounded-full bg-terminal-line" />
            <span className="ml-auto">
              <CopyButton
                value={command}
                label={t("openSource.copy")}
                size="xs"
                className="text-terminal-muted hover:bg-terminal-line hover:text-terminal-ink"
              />
            </span>
          </div>
          <pre className="px-5 py-5 font-mono text-[13px] leading-7 break-words whitespace-pre-wrap text-terminal-ink">
            <span className="text-terminal-muted">$</span> git clone
            https://github.com/gouvra/gouvra{"\n"}
            <span className="text-terminal-muted">$</span> cd gouvra && scripts/gen-secrets{"\n"}
            <span className="text-terminal-muted">$</span> docker compose up{"\n"}
            <span className="text-terminal-accent">✔</span>{" "}
            <span className="text-terminal-muted">
              api, worker, web, postgres, valkey, mailpit — ready on
            </span>{" "}
            <span className="text-terminal-ink">http://localhost:8080</span>
          </pre>
        </motion.div>
      </div>
    </section>
  );
}

function FinalCta() {
  const { t } = useTranslation("site");
  return (
    <section aria-labelledby="cta-title" className="px-4 pb-24 sm:px-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6, ease: ease.standard }}
        className="relative mx-auto max-w-5xl overflow-hidden rounded-panel bg-brand px-6 py-14 text-center text-on-solid shadow-lg sm:px-12"
      >
        <span
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.22),transparent_60%)]"
        />
        <h2
          id="cta-title"
          className="relative text-3xl font-semibold tracking-[-0.025em] sm:text-4xl"
        >
          {t("cta.title")}
        </h2>
        <p className="relative mx-auto mt-3 max-w-xl text-base opacity-90">{t("cta.body")}</p>
        <div className="relative mt-8 flex justify-center">
          <Button asChild size="lg" variant="secondary" rightIcon={<ArrowRight aria-hidden />}>
            <Link to="/register">{t("cta.button")}</Link>
          </Button>
        </div>
      </motion.div>
    </section>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-sm text-muted transition-colors hover:text-ink">
      {children}
    </a>
  );
}

function SiteFooter() {
  const { t } = useTranslation("site");
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <Logo />
          <p className="mt-2 text-sm text-muted">{t("footer.tagline")}</p>
        </div>
        <nav aria-label={t("footer.tagline")} className="flex flex-wrap gap-x-6 gap-y-2">
          <FooterLink href="/api/docs">{t("footer.docs")}</FooterLink>
          <FooterLink href={GITHUB_URL}>{t("footer.github")}</FooterLink>
          <FooterLink href={`${GITHUB_URL}/blob/main/LICENSE`}>{t("footer.license")}</FooterLink>
          <FooterLink href={`${GITHUB_URL}/blob/main/SECURITY.md`}>
            {t("footer.security")}
          </FooterLink>
        </nav>
      </div>
    </footer>
  );
}
