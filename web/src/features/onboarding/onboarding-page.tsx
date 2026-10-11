import { ArrowLeft, ArrowRight, Bot, Check, KeyRound, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { can } from "@/lib/auth/permissions";
import { useCurrentSession } from "@/lib/auth/session";
import { readLastWorkspace } from "@/lib/auth/storage";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Logo } from "@/components/brand/logo";
import { LanguageMenu } from "@/components/layout/language-menu";
import { ConnectionBanner, ThemeToggle, UserMenu } from "@/components/layout/shell-parts";
import { duration, ease, fadeUp, staggerChildren } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/feedback";
import { useWorkspace } from "@/features/workspaces/api";
import { CreateWorkspaceForm } from "@/features/workspaces/create-workspace-form";
import { InviteForm } from "@/features/workspaces/invite-form";
import { OnboardingChecklist } from "./onboarding-checklist";

const STEPS = ["welcome", "workspace", "invite", "checklist"] as const;
type Step = (typeof STEPS)[number];
const isStep = (value: string | null): value is Step =>
  value !== null && (STEPS as readonly string[]).includes(value);

/**
 * Screen F — first steps: welcome → create the workspace → invite (optional) → checklist.
 * The step and the new workspace live in the URL, so a reload resumes where it stopped.
 */
export function OnboardingPage() {
  const { t } = useTranslation("onboarding");
  const session = useCurrentSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("step");
  const slug = params.get("w");
  const workspace = slug ? session.workspaces.find((w) => w.slug === slug) : undefined;
  const { signOut } = useSignOut();

  let step: Step = isStep(requested) ? requested : "welcome";
  // Steps after creation need the workspace they belong to.
  if ((step === "invite" || step === "checklist") && !workspace) step = "workspace";
  const index = STEPS.indexOf(step);
  useDocumentTitle(`${t(`steps.${step}`)} — ${t("title")}`);

  /** Set when the person moves to another step: the new step's heading then takes focus. */
  const focusRequest = useRef(false);

  const go = (next: Step, workspaceSlug?: string) => {
    focusRequest.current = true;
    const nextParams = new URLSearchParams();
    nextParams.set("step", next);
    const w = workspaceSlug ?? slug;
    if (w && next !== "welcome") nextParams.set("w", w);
    setParams(nextParams);
  };

  const last = readLastWorkspace(session.user.id);
  const existing = session.workspaces.find((w) => w.slug === last) ?? session.workspaces[0];

  let content: ReactNode;
  if (step === "invite" && workspace) {
    content = (
      <InviteStep
        workspace={workspace}
        focusRef={focusRequest}
        onContinue={() => go("checklist")}
      />
    );
  } else if (step === "checklist" && workspace) {
    content = (
      <ChecklistStep
        workspace={workspace}
        focusRef={focusRequest}
        onFinish={() => void navigate(`/w/${workspace.slug}/overview`)}
      />
    );
  } else if (step === "workspace") {
    content = (
      <WorkspaceStep
        focusRef={focusRequest}
        onBack={() => go("welcome")}
        onCreated={(created) => go("invite", created)}
      />
    );
  } else {
    content = (
      <WelcomeStep
        name={session.user.display_name.trim().split(/\s+/)[0] ?? session.user.display_name}
        focusRef={focusRequest}
        onStart={() => go("workspace")}
        existing={existing ? { name: existing.name, slug: existing.slug } : null}
      />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <ConnectionBanner />
        <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          <div className="flex items-center gap-1">
            <LanguageMenu />
            <ThemeToggle />
            <UserMenu
              user={session.user}
              collapsed
              placement="bottom"
              className="size-10 w-10"
              onSignOut={() => signOut()}
            />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
          <Stepper current={index} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.section
              key={step}
              initial={{ opacity: 0, x: 18 }}
              animate={{
                opacity: 1,
                x: 0,
                transition: { duration: duration.slow, ease: ease.standard },
              }}
              exit={{
                opacity: 0,
                x: -18,
                transition: { duration: duration.fast, ease: ease.exit },
              }}
              className="mt-8 sm:mt-10"
            >
              {content}
            </motion.section>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  const { t } = useTranslation("onboarding");
  return (
    <nav aria-label={t("progressLabel")}>
      <p className="mb-3 text-xs font-medium text-muted sm:hidden">
        {t("stepOf", { current: current + 1, total: STEPS.length })} ·{" "}
        {t(`steps.${STEPS[current] ?? "welcome"}`)}
      </p>
      <ol className="flex items-center gap-2">
        {STEPS.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={step}
              aria-current={active ? "step" : undefined}
              className="flex flex-1 items-center gap-2 last:flex-none"
            >
              <span
                className={cn(
                  "relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors duration-300",
                  done && "border-brand bg-brand text-on-solid",
                  active && "border-brand bg-brand-soft text-brand-text",
                  !done && !active && "border-line-strong/60 bg-surface text-muted",
                )}
              >
                {done ? (
                  <Check aria-hidden className="size-3.5" strokeWidth={3} />
                ) : (
                  <span aria-hidden>{i + 1}</span>
                )}
                <span className="sr-only">
                  {t("stepOf", { current: i + 1, total: STEPS.length })}
                </span>
              </span>
              <span
                className={cn(
                  "hidden text-[13px] font-medium whitespace-nowrap sm:inline",
                  active ? "text-ink" : "text-muted",
                )}
              >
                {t(`steps.${step}`)}
              </span>
              {i < STEPS.length - 1 ? (
                <span aria-hidden className="relative h-px flex-1 overflow-hidden bg-line">
                  <motion.span
                    className="absolute inset-0 origin-left bg-brand"
                    initial={false}
                    animate={{
                      scaleX: done ? 1 : 0,
                      transition: { duration: duration.slow, ease: ease.standard },
                    }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

type FocusRequest = RefObject<boolean>;

function StepHeading({
  title,
  description,
  focusRef,
}: {
  title: string;
  description?: ReactNode;
  focusRef: FocusRequest;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusRef.current) return;
    focusRef.current = false;
    ref.current?.focus({ preventScroll: true });
  }, [focusRef]);
  return (
    <motion.div variants={fadeUp} className="space-y-2">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[28px]"
      >
        {title}
      </h1>
      {description ? (
        <p className="max-w-xl text-sm leading-relaxed text-pretty text-muted">{description}</p>
      ) : null}
    </motion.div>
  );
}

function WelcomeStep({
  name,
  focusRef,
  onStart,
  existing,
}: {
  name: string;
  focusRef: FocusRequest;
  onStart: () => void;
  existing: { name: string; slug: string } | null;
}) {
  const { t } = useTranslation("onboarding");
  const points = [
    { key: "agents", Icon: Bot },
    { key: "providers", Icon: KeyRound },
    { key: "team", Icon: Users },
  ] as const;
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <StepHeading
        title={t("welcome.title", { name })}
        description={t("welcome.body")}
        focusRef={focusRef}
      />
      <motion.div variants={fadeUp}>
        <Card className="p-6">
          <h2 className="text-[15px] font-semibold text-ink">{t("welcome.workspaceTitle")}</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-3">
            {points.map(({ key, Icon }) => (
              <li key={key} className="rounded-card border border-line bg-surface-2/50 p-4">
                <span className="inline-flex size-8 items-center justify-center rounded-field bg-brand-soft text-brand-text">
                  <Icon aria-hidden className="size-4" />
                </span>
                <p className="mt-3 text-[13px] leading-relaxed text-ink">
                  {t(`welcome.points.${key}`)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </motion.div>
      <motion.div
        variants={fadeUp}
        className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        {existing ? (
          <Button asChild variant="tertiary" leftIcon={<ArrowLeft aria-hidden />}>
            <Link to={`/w/${existing.slug}/overview`}>
              {t("welcome.existing", { name: existing.name })}
            </Link>
          </Button>
        ) : (
          <span />
        )}
        <Button size="lg" rightIcon={<ArrowRight aria-hidden />} onClick={onStart}>
          {t("welcome.start")}
        </Button>
      </motion.div>
    </motion.div>
  );
}

function WorkspaceStep({
  focusRef,
  onBack,
  onCreated,
}: {
  focusRef: FocusRequest;
  onBack: () => void;
  onCreated: (slug: string) => void;
}) {
  const { t } = useTranslation(["onboarding", "common", "shell"]);
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <StepHeading
        title={t("workspace.title")}
        description={t("workspace.subtitle")}
        focusRef={focusRef}
      />
      <motion.div variants={fadeUp}>
        <Card className="p-6">
          <CreateWorkspaceForm
            id="onboarding-workspace"
            onCreated={(workspace) => {
              toast.success(t("shell:createWorkspace.created", { name: workspace.name }));
              onCreated(workspace.slug);
            }}
            actions={({ pending }) => (
              <div className="mt-2 flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="tertiary" leftIcon={<ArrowLeft aria-hidden />} onClick={onBack}>
                  {t("common:actions.back")}
                </Button>
                <Button
                  type="submit"
                  size="lg"
                  loading={pending}
                  loadingText={t("workspace.submitting")}
                >
                  {t("workspace.submit")}
                </Button>
              </div>
            )}
          />
        </Card>
      </motion.div>
    </motion.div>
  );
}

function InviteStep({
  workspace,
  focusRef,
  onContinue,
}: {
  workspace: { id: string; name: string };
  focusRef: FocusRequest;
  onContinue: () => void;
}) {
  const { t } = useTranslation("onboarding");
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <StepHeading
        title={t("invite.title")}
        description={t("invite.subtitle", { workspace: workspace.name })}
        focusRef={focusRef}
      />
      <motion.div variants={fadeUp}>
        <Card className="p-6">
          <InviteForm
            workspaceId={workspace.id}
            onSent={onContinue}
            secondaryAction={
              <Button variant="tertiary" onClick={onContinue}>
                {t("invite.skip")}
              </Button>
            }
          />
        </Card>
      </motion.div>
    </motion.div>
  );
}

function ChecklistStep({
  workspace,
  focusRef,
  onFinish,
}: {
  workspace: { id: string; slug: string; name: string };
  focusRef: FocusRequest;
  onFinish: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const detail = useWorkspace(workspace.id);
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <StepHeading
        title={t("checklistStep.title", { workspace: workspace.name })}
        description={t("checklistStep.subtitle")}
        focusRef={focusRef}
      />
      <motion.div variants={fadeUp}>
        <OnboardingChecklist
          workspace={workspace}
          canDismiss={can(detail.data, "workspace:update")}
          hideWhenDismissed={false}
          footer={
            <Button size="lg" rightIcon={<ArrowRight aria-hidden />} onClick={onFinish}>
              {t("checklist.goToWorkspace", { workspace: workspace.name })}
            </Button>
          }
        />
      </motion.div>
    </motion.div>
  );
}
