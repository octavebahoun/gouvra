import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { onEmailNotVerified, onUnauthorized } from "@/lib/api/http";
import { supportedLanguages, type Language } from "@/lib/i18n/resources";
import {
  getThemePreference,
  setThemePreference,
  useTheme,
  type ThemePreference,
} from "@/lib/theme";
import { applySignedOut, authKeys, useSession, useUpdateProfile } from "./session";
import { markLocalPreferencesChosen, takeLocalPreferencesChosen } from "./storage";
import type { Session } from "./types";

/**
 * Reacts to session problems reported by any API call:
 * - 401 `unauthorized` (expired or revoked session): forget the session and every cached datum;
 *   the route guards then send the person to `/login?next=…`;
 * - 403 `email_not_verified`: refresh the session so guards show the confirmation screen.
 */
export function SessionWatcher() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("shell");

  useEffect(
    () =>
      onUnauthorized(() => {
        const hadSession = Boolean(queryClient.getQueryData<Session | null>(authKeys.session));
        applySignedOut(queryClient);
        if (hadSession) toast.info(t("session.expired"), { id: "session-expired" });
      }),
    [queryClient, t],
  );

  useEffect(
    () =>
      onEmailNotVerified(() => {
        void queryClient.invalidateQueries({ queryKey: authKeys.session });
      }),
    [queryClient],
  );

  return null;
}

const isTheme = (value: string): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";
const isLanguage = (value: string): value is Language =>
  (supportedLanguages as readonly string[]).includes(value);
const toLanguage = (value: string | undefined): Language => {
  const short = (value ?? "en").split("-")[0] ?? "en";
  return isLanguage(short) ? short : "en";
};

/**
 * Keeps theme and language in sync with the profile, both ways:
 * - server → device: when the signed-in profile changes (sign-in, another device), apply it;
 * - device → server: any local change (user menu, theme toggle, account page) is saved with
 *   `PATCH /me`. A choice made before signing in wins over the stored profile at sign-in.
 */
export function PreferencesSync() {
  const { t, i18n } = useTranslation("shell");
  const { data: session } = useSession();
  const { preference } = useTheme();
  const language = toLanguage(i18n.resolvedLanguage);
  const { mutate: saveProfile } = useUpdateProfile();

  const server = useRef<{ userId: string; theme: string; locale: string } | null>(null);
  const seen = useRef<{ theme: ThemePreference; language: Language } | null>(null);

  const userId = session?.user.id;
  const serverTheme = session?.user.theme;
  const serverLocale = session?.user.locale;

  // server → device
  useEffect(() => {
    if (!userId || !serverTheme || !serverLocale) {
      server.current = null;
      return;
    }
    const firstForUser = server.current?.userId !== userId;
    server.current = { userId, theme: serverTheme, locale: serverLocale };
    const current = { theme: getThemePreference(), language: toLanguage(i18n.resolvedLanguage) };
    if (firstForUser && takeLocalPreferencesChosen()) {
      const changes: { theme?: ThemePreference; locale?: Language } = {};
      if (current.theme !== serverTheme) changes.theme = current.theme;
      if (current.language !== serverLocale) changes.locale = current.language;
      if (changes.theme ?? changes.locale) saveProfile(changes);
      return;
    }
    if (isTheme(serverTheme) && serverTheme !== current.theme) setThemePreference(serverTheme);
    if (isLanguage(serverLocale) && serverLocale !== current.language) {
      void i18n.changeLanguage(serverLocale);
    }
  }, [userId, serverTheme, serverLocale, saveProfile, i18n]);

  // device → server
  useEffect(() => {
    const before = seen.current;
    seen.current = { theme: preference, language };
    if (!before || (before.theme === preference && before.language === language)) return;
    if (!userId) {
      markLocalPreferencesChosen();
      return;
    }
    const stored = server.current;
    if (!stored) return;
    const changes: { theme?: ThemePreference; locale?: Language } = {};
    if (preference !== stored.theme) changes.theme = preference;
    if (language !== stored.locale) changes.locale = language;
    if (!changes.theme && !changes.locale) return;
    saveProfile(changes, {
      onError: () => toast.error(t("preferences.saveFailed"), { id: "preferences-save" }),
    });
  }, [preference, language, userId, saveProfile, t]);

  return null;
}
