import type { TFunction } from "i18next";
import { Bot, Building2, KeyRound, Play, Sparkles, UserPlus, type LucideIcon } from "lucide-react";

type StepCopy = { title: string; description: string; cta: string };
export type StepMeta = StepCopy & { Icon: LucideIcon; to: string | null };

/** Turn an unknown key ("connect_slack") into readable words ("Connect slack"). */
function humanise(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Presentation of each checklist step. Feature modules add steps on the API side over time
 * (phase 3: provider, agent, execution); unknown keys still render, with a generic label.
 */
export function stepMeta(key: string, basePath: string, t: TFunction<"onboarding">): StepMeta {
  switch (key) {
    case "create_workspace":
      return {
        Icon: Building2,
        to: `${basePath}/settings/general`,
        title: t("checklist.items.create_workspace.title"),
        description: t("checklist.items.create_workspace.description"),
        cta: t("checklist.items.create_workspace.cta"),
      };
    case "invite_teammate":
      return {
        Icon: UserPlus,
        to: `${basePath}/settings/members`,
        title: t("checklist.items.invite_teammate.title"),
        description: t("checklist.items.invite_teammate.description"),
        cta: t("checklist.items.invite_teammate.cta"),
      };
    case "configure_provider":
      return {
        Icon: KeyRound,
        to: `${basePath}/providers`,
        title: t("checklist.items.configure_provider.title"),
        description: t("checklist.items.configure_provider.description"),
        cta: t("checklist.items.configure_provider.cta"),
      };
    case "create_agent":
      return {
        Icon: Bot,
        to: `${basePath}/agents/new`,
        title: t("checklist.items.create_agent.title"),
        description: t("checklist.items.create_agent.description"),
        cta: t("checklist.items.create_agent.cta"),
      };
    case "run_execution":
      return {
        Icon: Play,
        to: `${basePath}/agents`,
        title: t("checklist.items.run_execution.title"),
        description: t("checklist.items.run_execution.description"),
        cta: t("checklist.items.run_execution.cta"),
      };
    default:
      return {
        Icon: Sparkles,
        to: null,
        title: t("checklist.items.fallback.title", { name: humanise(key) }),
        description: t("checklist.items.fallback.description"),
        cta: t("checklist.items.fallback.cta"),
      };
  }
}
