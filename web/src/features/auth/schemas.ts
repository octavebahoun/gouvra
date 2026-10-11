import type { TFunction } from "i18next";
import { z } from "zod";
import { readPendingInvite } from "@/lib/auth/storage";
import type { Session } from "@/lib/auth/types";

/** Light client-side check; the API validates addresses for real. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailSchema = (t: TFunction<"auth">) =>
  z
    .string()
    .trim()
    .min(1, t("validation.emailRequired"))
    .regex(EMAIL_PATTERN, t("validation.emailInvalid"));

export const displayNameSchema = (t: TFunction<"auth">) =>
  z.string().trim().min(1, t("validation.nameRequired")).max(80, t("validation.nameTooLong"));

/** Length only: the rest of the policy (common passwords, e-mail reuse) is the server's call. */
export const newPasswordSchema = (t: TFunction<"auth">) =>
  z
    .string()
    .min(1, t("validation.passwordRequired"))
    .min(10, t("password.errors.too_short"))
    .max(128, t("password.errors.too_long"))
    .refine((value) => value.trim().length > 0, t("password.errors.blank"));

/** Where to go once an e-mail link has signed someone in. */
export function pathAfterLinkSignIn(session: Session): string {
  if (readPendingInvite()) return "/invite";
  return session.workspaces.length === 0 ? "/onboarding" : "/app";
}
