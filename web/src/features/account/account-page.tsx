import { zodResolver } from "@hookform/resolvers/zod";
import { Check, KeyRound, Mail, Monitor, Moon, Sun } from "lucide-react";
import { motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { cn } from "@/lib/cn";
import { useCurrentSession, useMeta, useUpdateProfile } from "@/lib/auth/session";
import { currentLanguage } from "@/lib/i18n";
import { languageNames, supportedLanguages } from "@/lib/i18n/resources";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { useDocumentTitle } from "@/lib/use-document-title";
import { GitHubIcon, GoogleIcon } from "@/components/brand/brand-icons";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/components/layout/settings-section";
import { staggerChildren } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/field";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { EmailDialog, PasswordDialog } from "./security-dialogs";
import { SessionsSection } from "./sessions-section";

/** Screen R — profile & preferences, sign-in security and active sessions. */
export function AccountPage() {
  const { t } = useTranslation("account");
  useDocumentTitle(t("title"));
  return (
    <PageContainer>
      <PageHeader title={t("title")} description={t("description")} />
      <motion.div
        variants={staggerChildren(0.06)}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-10"
      >
        <ProfileSection />
        <SecuritySection />
        <ConnectionsSection />
        <PreferencesSection />
        <SessionsSection />
      </motion.div>
    </PageContainer>
  );
}

function ProfileSection() {
  const { t } = useTranslation("account");
  const { user } = useCurrentSession();
  const update = useUpdateProfile();
  const [problem, setProblem] = useState<unknown>(null);
  const schema = useMemo(
    () =>
      z.object({
        displayName: z
          .string()
          .trim()
          .min(1, t("profile.nameRequired"))
          .max(80, t("profile.nameTooLong")),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { displayName: user.display_name },
  });
  const { isDirty, errors } = form.formState;
  const typedName = useWatch({ control: form.control, name: "displayName" });

  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ displayName: user.display_name });
  }, [user.display_name, form]);

  const onSubmit = form.handleSubmit(async ({ displayName }) => {
    setProblem(null);
    try {
      const saved = await update.mutateAsync({ display_name: displayName });
      form.reset({ displayName: saved.display_name });
      toast.success(t("profile.saved"));
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "display_name"
          ? { field: "displayName", message: t("profile.nameRequired") }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });

  return (
    <SettingsSection id="profile" title={t("profile.title")} description={t("profile.description")}>
      <Card>
        <form
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start"
        >
          <Avatar name={typedName.trim() || user.display_name} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {problem ? <FormProblemAlert error={problem} /> : null}
            <Field label={t("profile.displayName")} error={errors.displayName?.message}>
              <Input autoComplete="name" maxLength={80} {...form.register("displayName")} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={!isDirty} loading={update.isPending}>
                {t("profile.save")}
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </SettingsSection>
  );
}

function SecuritySection() {
  const { t } = useTranslation("account");
  const { user } = useCurrentSession();
  const [dialog, setDialog] = useState<"email" | "password" | null>(null);
  const providers = user.oauth_providers.map(providerName).join(", ");

  return (
    <SettingsSection
      id="security"
      title={t("security.title")}
      description={t("security.description")}
    >
      <Card className="divide-y divide-line">
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Mail aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13px] text-muted">{t("email.title")}</h3>
              <p className="truncate font-medium text-ink">{user.email}</p>
              <p className="mt-0.5">
                {user.email_verified ? (
                  <Badge tone="success" icon={<Check aria-hidden />}>
                    {t("email.verified")}
                  </Badge>
                ) : (
                  <Badge tone="warning">{t("email.unverified")}</Badge>
                )}
              </p>
            </div>
          </div>
          <Button variant="secondary" className="shrink-0" onClick={() => setDialog("email")}>
            {t("email.change")}
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
              <KeyRound aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-medium text-ink">{t("password.title")}</h3>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                {user.has_password
                  ? t("password.changeDescription")
                  : providers
                    ? t("password.setDescription", { providers })
                    : t("password.setDescriptionNoProvider")}
              </p>
            </div>
          </div>
          <Button variant="secondary" className="shrink-0" onClick={() => setDialog("password")}>
            {user.has_password ? t("password.change") : t("password.set")}
          </Button>
        </div>
      </Card>
      <EmailDialog
        open={dialog === "email"}
        onOpenChange={(open) => setDialog(open ? "email" : null)}
        onNeedPassword={() => setDialog("password")}
      />
      <PasswordDialog
        open={dialog === "password"}
        onOpenChange={(open) => setDialog(open ? "password" : null)}
      />
    </SettingsSection>
  );
}

function providerName(provider: string): string {
  return provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider;
}

function ConnectionsSection() {
  const { t } = useTranslation("account");
  const { user } = useCurrentSession();
  const meta = useMeta();
  const providers = [
    ...new Set([...(meta.data?.oauth_providers ?? []), ...user.oauth_providers]),
  ].filter((p) => p === "github" || p === "google");

  return (
    <SettingsSection
      id="connections"
      title={t("connections.title")}
      description={t("connections.description")}
    >
      <Card>
        {providers.length === 0 ? (
          <p className="p-5 text-[13px] text-muted">{t("connections.none")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {providers.map((provider) => {
              const connected = user.oauth_providers.includes(provider);
              const Icon = provider === "github" ? GitHubIcon : GoogleIcon;
              return (
                <li key={provider} className="flex items-center justify-between gap-3 px-5 py-4">
                  <span className="flex items-center gap-3">
                    <span className="inline-flex size-9 items-center justify-center rounded-full border border-line bg-surface">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="font-medium text-ink">{providerName(provider)}</span>
                  </span>
                  {connected ? (
                    <Badge tone="success" icon={<Check aria-hidden />}>
                      {t("connections.connected")}
                    </Badge>
                  ) : (
                    <Badge tone="outline">{t("connections.notConnected")}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="border-t border-line bg-surface-2/40 px-5 py-3 text-[13px] text-muted">
          {t("connections.howToLink")}
        </p>
      </Card>
    </SettingsSection>
  );
}

const THEMES: { value: ThemePreference; Icon: typeof Sun }[] = [
  { value: "light", Icon: Sun },
  { value: "dark", Icon: Moon },
  { value: "system", Icon: Monitor },
];

/** Theme and language apply at once; <PreferencesSync> saves them to the profile. */
function PreferencesSection() {
  const { t, i18n } = useTranslation(["account", "common"]);
  const { preference } = useTheme();
  const language = currentLanguage();

  return (
    <SettingsSection
      id="preferences"
      title={t("preferences.title")}
      description={t("preferences.description")}
    >
      <Card className="flex flex-col gap-6 p-5">
        <div>
          <p id="preference-theme" className="text-[13px] font-medium text-ink">
            {t("preferences.theme")}
          </p>
          <RadioGroup.Root
            value={preference}
            onValueChange={(value) => setThemePreference(value as ThemePreference)}
            aria-labelledby="preference-theme"
            className="mt-2.5 grid grid-cols-3 gap-2 sm:gap-3"
          >
            {THEMES.map(({ value, Icon }) => (
              <RadioGroup.Item
                key={value}
                value={value}
                className={cn(
                  "group relative flex flex-col overflow-hidden rounded-card border border-line bg-surface text-left transition-[border-color,box-shadow] duration-150",
                  "hover:border-line-strong/70 data-[state=checked]:border-brand data-[state=checked]:shadow-glow",
                )}
              >
                <ThemePreview theme={value} />
                <span className="flex items-center justify-between gap-2 px-2.5 py-2.5 sm:px-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon aria-hidden className="hidden size-4 shrink-0 text-muted sm:block" />
                    <span className="text-sm font-medium text-ink">
                      {t(`common:theme.${value}`)}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="inline-flex size-4.5 items-center justify-center rounded-full border border-line-strong/70 group-data-[state=checked]:border-brand group-data-[state=checked]:bg-brand"
                  >
                    <Check
                      className="hidden size-3 text-on-solid group-data-[state=checked]:block"
                      strokeWidth={3}
                    />
                  </span>
                </span>
                <span className="-mt-1.5 hidden px-3 pb-3 text-xs text-muted sm:block">
                  {t(`preferences.themeDescriptions.${value}`)}
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
        <div>
          <p id="preference-language" className="text-[13px] font-medium text-ink">
            {t("preferences.language")}
          </p>
          <RadioGroup.Root
            value={language}
            onValueChange={(value) => void i18n.changeLanguage(value)}
            aria-labelledby="preference-language"
            className="mt-2.5 inline-flex rounded-field border border-line bg-surface-2 p-1"
          >
            {supportedLanguages.map((lng) => (
              <RadioGroup.Item
                key={lng}
                value={lng}
                lang={lng}
                className={cn(
                  "relative inline-flex h-8 min-w-24 items-center justify-center rounded-[5px] px-3 text-sm font-medium text-muted transition-colors max-md:h-10",
                  "hover:text-ink data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-sm",
                )}
              >
                {languageNames[lng]}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
      </Card>
    </SettingsSection>
  );
}

/** Miniature app window drawn with the chosen theme's tokens (scoped with data-theme-scope). */
function ThemePreview({ theme }: { theme: ThemePreference }) {
  if (theme === "system") {
    return (
      <span aria-hidden className="relative block h-14 border-b border-line sm:h-20">
        <span className="absolute inset-0 [clip-path:polygon(0_0,100%_0,0_100%)]">
          <MiniWindow scope="light" />
        </span>
        <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
          <MiniWindow scope="dark" />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden className="block h-14 border-b border-line sm:h-20">
      <MiniWindow scope={theme} />
    </span>
  );
}

function MiniWindow({ scope }: { scope: "light" | "dark" }) {
  return (
    <span
      data-theme-scope={scope}
      className="flex h-full w-full gap-1.5 bg-canvas p-2 sm:gap-2 sm:p-2.5"
    >
      <span className="flex w-1/4 flex-col gap-1.5 rounded-[5px] bg-surface p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-brand" />
        <span className="h-1.5 w-full rounded-full bg-line" />
        <span className="h-1.5 w-2/3 rounded-full bg-line" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 rounded-[5px] border border-line bg-surface p-2">
        <span className="h-2 w-1/2 rounded-full bg-ink/80" />
        <span className="h-1.5 w-5/6 rounded-full bg-line" />
        <span className="mt-auto h-3 w-1/3 rounded-[3px] bg-brand" />
      </span>
    </span>
  );
}
