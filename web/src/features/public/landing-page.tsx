import { ArrowRight, Check, ShieldCheck, Terminal, Boxes, ChevronDown } from "lucide-react";
import {
  LayoutGroup,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/auth/session";
import { REPOSITORY_URL } from "@/lib/links";
import { useDocumentTitle } from "@/lib/use-document-title";
import { GitHubIcon } from "@/components/brand/brand-icons";
import { Logo } from "@/components/brand/logo";
import { LanguageMenu } from "@/components/layout/language-menu";
import { ThemeToggle } from "@/components/layout/shell-parts";
import { ease, fadeUp, staggerChildren } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { HeroVisual } from "./hero-visual";
import { Features } from "./landing-features";
import { CompassDial, DialMark, LandingAtmosphere } from "./landing-shared";
import { Steps } from "./landing-steps";

const GITHUB_URL = REPOSITORY_URL;
const VERBS = ["build", "run", "evaluate", "supervise"] as const;
const SECTION_IDS = ["features", "how", "open-source"];

function useSpotlight() {
  const reduced = useReducedMotion() ?? false;
  const fine = useMediaQuery("(pointer: fine)");
  const rawX = useMotionValue(-480);
  const rawY = useMotionValue(-480);
  const opacity = useMotionValue(0);
  const x = useSpring(rawX, { stiffness: 80, damping: 22, mass: 0.35 });
  const y = useSpring(rawY, { stiffness: 80, damping: 22, mass: 0.35 });
  const enabled = fine && !reduced;

  return {
    x,
    y,
    opacity,
    onPointerMove: enabled
      ? (event: PointerEvent<HTMLElement>) => {
          const rect = event.currentTarget.getBoundingClientRect();
          rawX.set(event.clientX - rect.left);
          rawY.set(event.clientY - rect.top);
          opacity.set(1);
        }
      : undefined,
    onPointerLeave: enabled ? () => opacity.set(0) : undefined,
  };
}

const COMMAND = `git clone ${REPOSITORY_URL} && cd gouvra && scripts/gen-secrets && docker compose up`;

const TERMINAL_LINES = [
  { kind: "cmd" as const, text: `git clone ${REPOSITORY_URL}` },
  { kind: "cmd" as const, text: "cd gouvra && scripts/gen-secrets" },
  { kind: "cmd" as const, text: "docker compose up" },
  { kind: "ok" as const, text: "api, worker, web, postgres, valkey, mailpit — ready on" },
];

/** Screen A — the public site: value proposition, capabilities, how it works, open source. */
export function LandingPage() {
  const { t } = useTranslation(["site", "common"]);
  useDocumentTitle(`${t("common:app.name")} — ${t("common:app.tagline")}`);
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.style.scrollBehavior = reduced ? "auto" : "smooth";
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, []);
  return (
    <div className="min-h-dvh overflow-x-clip bg-canvas">
      <a
        href="#main"
        className="sr-only z-[60] rounded-field bg-brand px-3 py-2 text-on-solid focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("common:a11y.skipToContent")}
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
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

/**
 * The section crossing a band just above the middle of the screen. Sections are compared by
 * whether they cross the band, not by how much of them is visible: "How it works" is several
 * screens tall, so its visible share stays small even while it fills the screen.
 */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (nodes.length === 0) return undefined;
    const crossing = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) crossing.add(entry.target.id);
          else crossing.delete(entry.target.id);
        }
        setActive(ids.find((id) => crossing.has(id)) ?? null);
      },
      { rootMargin: "-28% 0px -55% 0px", threshold: 0 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function SiteHeader() {
  const { t } = useTranslation(["site", "common"]);
  const session = useSession();
  const { scrollY, scrollYProgress } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 28, mass: 0.3 });
  const needleTarget = useTransform(scrollYProgress, [0.06, 0.9], [0, 270]);
  const needle = useSpring(needleTarget, { stiffness: 70, damping: 18, mass: 0.45 });
  useEffect(() => scrollY.on("change", (y) => setScrolled(y > 8)), [scrollY]);
  const signedIn = Boolean(session.data);
  const navItems = [
    { href: "#features", id: "features", label: t("nav.features") },
    { href: "#how", id: "how", label: t("nav.how") },
    { href: "#open-source", id: "open-source", label: t("nav.openSource") },
    { href: "/api/docs", id: "", label: t("nav.docs") },
  ];
  const active = useActiveSection(SECTION_IDS);

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
        <LayoutGroup>
          <nav
            aria-label={t("nav.label")}
            className="hidden flex-1 items-center gap-1 min-[1100px]:flex"
          >
            {navItems.map((item) => {
              const on = item.id !== "" && active === item.id;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={on ? "location" : undefined}
                  className={cn(
                    "relative rounded-field px-3 py-2 text-sm whitespace-nowrap transition-colors",
                    on ? "text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {item.label}
                  {on ? (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full bg-brand"
                      transition={{ duration: 0.28, ease: ease.standard }}
                    />
                  ) : null}
                </a>
              );
            })}
          </nav>
        </LayoutGroup>
        <div className="ml-auto flex items-center gap-1.5">
          <CompassDial
            rotation={needle}
            className="mr-1 hidden size-9 text-brand min-[1100px]:block"
          />
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
      <nav
        aria-label={t("nav.label")}
        className="flex [scrollbar-width:none] gap-1 overflow-x-auto border-t border-line/70 px-3 py-1.5 min-[1100px]:hidden"
      >
        {navItems.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={cn(
              "shrink-0 rounded-field px-3 py-2 text-xs font-medium transition-colors",
              item.id !== "" && active === item.id
                ? "bg-surface-2 text-ink"
                : "text-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <motion.div
        aria-hidden
        style={{ scaleX: progress }}
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand"
      />
    </header>
  );
}

function useVerbIndex() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced) return undefined;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % VERBS.length), 2400);
    return () => window.clearInterval(timer);
  }, [reduced]);
  return index;
}

/** The four jobs, with the one currently spoken in the title marked. */
function VerbLegend({ index }: { index: number }) {
  const { t } = useTranslation("site");
  return (
    <ul aria-hidden className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 lg:justify-start">
      {VERBS.map((verb, i) => {
        const on = i === index;
        return (
          <li key={verb} className="relative pb-1 text-[13px] font-medium">
            <span className={on ? "text-ink" : "text-muted"}>{t(`hero.verbs.${verb}`)}</span>
            {on ? (
              <motion.span
                layoutId="verb-tick"
                className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-brand"
                transition={{ duration: 0.35, ease: ease.standard }}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** "Build / Run / Evaluate / Supervise" — the verb rolls from below, one word at a time. */
function RollingVerb({ index }: { index: number }) {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion() ?? false;
  const label = t(`hero.verbs.${VERBS[index] ?? "build"}`);
  const [frame, setFrame] = useState<{ current: string; previous: string | null }>({
    current: label,
    previous: null,
  });
  if (frame.current !== label) {
    setFrame({ current: label, previous: reduced ? null : frame.current });
  }
  useEffect(() => {
    if (!frame.previous) return undefined;
    const timer = window.setTimeout(() => {
      setFrame((current) => ({ ...current, previous: null }));
    }, 560);
    return () => window.clearTimeout(timer);
  }, [frame.previous]);

  const longest = VERBS.map((verb) => t(`hero.verbs.${verb}`)).reduce((a, b) =>
    b.length > a.length ? b : a,
  );

  return (
    <span className="relative inline-grid justify-items-center overflow-hidden pb-[0.12em] align-bottom lg:justify-items-start">
      <span className="invisible col-start-1 row-start-1 whitespace-nowrap">{longest}</span>
      {frame.previous ? (
        <span
          className={cn(
            "col-start-1 row-start-1 bg-gradient-to-r from-[var(--gv-brand)] to-[var(--gv-chart-4)] bg-clip-text whitespace-nowrap text-transparent",
            !reduced && "animate-[gv-roll-out_0.55s_cubic-bezier(0.2,0,0,1)_both]",
          )}
        >
          {frame.previous}
        </span>
      ) : null}
      <span
        key={frame.current}
        className={cn(
          "col-start-1 row-start-1 bg-gradient-to-r from-[var(--gv-brand)] to-[var(--gv-chart-4)] bg-clip-text whitespace-nowrap text-transparent",
          !reduced && "animate-[gv-roll_0.55s_cubic-bezier(0.2,0,0,1)_both]",
        )}
      >
        {frame.current}
      </span>
    </span>
  );
}

function Hero() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const verbIndex = useVerbIndex();
  const ref = useRef<HTMLElement>(null);
  const spotlight = useSpotlight();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const glow = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [0, 120]);
  const fade = useTransform(scrollYProgress, [0, 0.7], [1, reduced ? 1 : 0.35]);

  return (
    <section
      ref={ref}
      aria-labelledby="hero-title"
      onPointerMove={spotlight.onPointerMove}
      onPointerLeave={spotlight.onPointerLeave}
      className="relative isolate overflow-hidden pt-8 pb-16 sm:pt-12 lg:pb-10"
    >
      <LandingAtmosphere spotlight={spotlight} />
      <motion.div
        aria-hidden
        style={{ y: glow }}
        className="pointer-events-none absolute top-[-12rem] left-1/2 -z-10 h-[36rem] w-[64rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gv-brand)_16%,transparent),transparent)]"
      />
      <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-6 lg:py-4">
        <motion.div
          variants={staggerChildren(0.08, 0.04)}
          initial="hidden"
          animate="visible"
          style={{ opacity: fade }}
          className="relative z-10 text-center lg:py-8 lg:text-left"
        >
          <motion.p
            variants={fadeUp}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-muted shadow-sm backdrop-blur"
          >
            <span className="relative inline-flex size-2">
              <span
                aria-hidden
                className="absolute inset-0 animate-breathe rounded-full bg-brand"
              />
              <span className="relative size-2 rounded-full bg-brand" />
            </span>
            {t("hero.eyebrow")}
          </motion.p>
          <motion.h1
            id="hero-title"
            variants={fadeUp}
            className="mt-5 text-[2.35rem] leading-[1.02] font-semibold tracking-[-0.04em] text-balance text-ink sm:text-5xl lg:text-[3.15rem] xl:text-[3.4rem]"
          >
            <span className="sr-only">{t("hero.titleSr")}</span>
            <span aria-hidden>
              <RollingVerb index={verbIndex} /> {t("hero.titleRest")}
              <br />
              <span className="text-muted">{t("hero.titleLine2")}</span>
            </span>
          </motion.h1>
          <motion.p
            variants={fadeUp}
            className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-pretty text-muted sm:text-lg lg:mx-0"
          >
            {t("hero.subtitle")}
          </motion.p>
          <motion.div
            variants={fadeUp}
            className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start"
          >
            <motion.div
              whileHover={reduced ? undefined : { y: -2 }}
              whileTap={reduced ? undefined : { y: 0 }}
            >
              <Button asChild size="lg" rightIcon={<ArrowRight aria-hidden />}>
                <Link to="/register">{t("hero.primary")}</Link>
              </Button>
            </motion.div>
            <motion.div
              whileHover={reduced ? undefined : { y: -2 }}
              whileTap={reduced ? undefined : { y: 0 }}
            >
              <Button asChild size="lg" variant="secondary" leftIcon={<GitHubIcon />}>
                <a href={GITHUB_URL}>{t("hero.secondary")}</a>
              </Button>
            </motion.div>
          </motion.div>
          <motion.div variants={fadeUp}>
            <VerbLegend index={verbIndex} />
          </motion.div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 36 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0 : 0.85, delay: 0.22, ease: ease.standard }}
          className="relative z-10 min-w-0"
        >
          <p className="sr-only">{t("hero.visualLabel")}</p>
          <HeroVisual target={ref} className="max-w-none" />
        </motion.div>
      </div>
      <motion.a
        href="#how"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reduced ? 0 : 1, duration: reduced ? 0 : 0.5 }}
        className="relative z-20 mx-auto mt-4 flex w-fit flex-col items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink lg:mt-2"
      >
        {t("hero.scroll")}
        <ChevronDown aria-hidden className="size-4 motion-safe:animate-float" />
      </motion.a>
    </section>
  );
}

function Trust() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  const names = ["DeepSeek", "Anthropic Claude", "OpenAI-compatible APIs", t("trust.offline")];
  const items = [...names, ...names];

  return (
    <section aria-label={t("trust.label")} className="border-y border-line bg-surface/60">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-6 sm:px-6">
        <span className="shrink-0 text-sm text-muted">{t("trust.label")}</span>
        {reduced ? (
          <ul className="flex flex-wrap gap-2">
            {names.map((name) => (
              <li key={name}>
                <TrustChip name={name} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-1/5 bg-gradient-to-r from-transparent via-brand/25 to-transparent motion-safe:animate-bus"
            />
            <ul className="flex w-max animate-marquee gap-3 pr-3 hover:[animation-play-state:paused]">
              {items.map((name, i) => (
                <li key={`${name}-${i}`} aria-hidden={i >= names.length}>
                  <TrustChip name={name} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function TrustChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink shadow-sm">
      <span aria-hidden className="size-1.5 rounded-full bg-brand" />
      {name}
    </span>
  );
}

function useTypedTerminal(active: boolean, reduced: boolean) {
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    if (reduced || !active) return undefined;
    let lineIdx = 0;
    let charIdx = 0;
    let timer = 0;
    const tick = () => {
      const current = TERMINAL_LINES[lineIdx];
      if (!current) return;
      if (charIdx < current.text.length) {
        charIdx += 2;
        setLine(lineIdx);
        setChars(charIdx);
        timer = window.setTimeout(tick, 16);
        return;
      }
      lineIdx += 1;
      charIdx = 0;
      setLine(lineIdx);
      setChars(0);
      if (lineIdx < TERMINAL_LINES.length) timer = window.setTimeout(tick, 320);
    };
    timer = window.setTimeout(tick, 240);
    return () => window.clearTimeout(timer);
  }, [active, reduced]);

  return { line, chars };
}

function OpenSource() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion() ?? false;
  const terminal = useRef<HTMLDivElement>(null);
  // The commands type themselves when the terminal comes into view, not while it is off screen.
  const inView = useInView(terminal, { once: true, amount: 0.4 });
  const typed = useTypedTerminal(inView && !reduced, reduced);
  const typedLine = reduced ? TERMINAL_LINES.length : typed.line;
  const currentLine = TERMINAL_LINES[typed.line];
  const partial =
    reduced || !currentLine ? 0 : Math.min(1, typed.chars / Math.max(1, currentLine.text.length));
  const boot = reduced ? 1 : Math.min(1, (typed.line + partial) / TERMINAL_LINES.length);
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
          ref={terminal}
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
            <span className="ml-3 font-mono text-[11px] text-terminal-muted tabular-nums">
              {Math.round(boot * TERMINAL_LINES.length)}/{TERMINAL_LINES.length}
            </span>
            <span className="ml-auto">
              <CopyButton
                value={COMMAND}
                label={t("openSource.copy")}
                size="xs"
                className="text-terminal-muted hover:bg-terminal-line hover:text-terminal-ink"
              />
            </span>
          </div>
          <pre className="min-h-[11.5rem] px-5 py-5 font-mono text-[13px] leading-7 break-words whitespace-pre-wrap text-terminal-ink">
            {TERMINAL_LINES.map((entry, i) => {
              const done = i < typedLine;
              const current = i === typedLine;
              if (!done && !current) return null;
              const shown = done ? entry.text : entry.text.slice(0, typed.chars);
              return (
                <span key={entry.text}>
                  {entry.kind === "cmd" ? (
                    <>
                      <span className="text-terminal-muted">$ </span>
                      {shown}
                    </>
                  ) : (
                    <>
                      <span className="text-terminal-accent">✔ </span>
                      <span className="text-terminal-muted">{shown}</span>
                      {done ? (
                        <>
                          {" "}
                          <span className="text-terminal-ink">http://localhost:8080</span>
                        </>
                      ) : null}
                    </>
                  )}
                  {current && !reduced ? (
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-terminal-accent" />
                  ) : null}
                  {"\n"}
                </span>
              );
            })}
          </pre>
          <div className="h-0.5 bg-terminal-line">
            <motion.div
              className="h-full origin-left bg-terminal-accent"
              initial={false}
              animate={{ scaleX: boot }}
              transition={{ duration: reduced ? 0 : 0.2, ease: ease.standard }}
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function FinalCta() {
  const { t } = useTranslation("site");
  const reduced = useReducedMotion();
  return (
    <section id="start" aria-labelledby="cta-title" className="scroll-mt-20 px-4 pb-24 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.45 }}
        transition={{ duration: 0.6, ease: ease.standard }}
        className="relative mx-auto grid max-w-5xl items-center gap-8 overflow-hidden rounded-panel bg-brand px-6 py-14 text-center text-on-solid shadow-lg sm:px-12 lg:grid-cols-[auto_1fr] lg:text-left"
      >
        <span
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.22),transparent_55%)]"
        />
        <span
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.1)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_30%_50%,black,transparent_72%)] bg-[size:40px_40px] opacity-30"
        />
        <DialMark className="relative mx-auto size-36 text-on-solid opacity-90 lg:size-44" />
        <div className="relative">
          <h2 id="cta-title" className="text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
            {t("cta.title")}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base opacity-90 lg:mx-0">{t("cta.body")}</p>
          <div className="mt-8 flex justify-center lg:justify-start">
            <motion.div whileHover={reduced ? undefined : { y: -2 }}>
              <Button asChild size="lg" variant="secondary" rightIcon={<ArrowRight aria-hidden />}>
                <Link to="/register">{t("cta.button")}</Link>
              </Button>
            </motion.div>
          </div>
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
