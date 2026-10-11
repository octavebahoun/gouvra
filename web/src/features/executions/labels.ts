import { useTranslation } from "react-i18next";

const TRIGGERS = [
  "manual",
  "api",
  "retry",
  "schedule",
  "webhook",
  "evaluation",
  "workflow",
  "agent",
] as const;
type TriggerKey = (typeof TRIGGERS)[number];

export function useTriggerLabel() {
  const { t } = useTranslation("executions");
  return (trigger: string) =>
    (TRIGGERS as readonly string[]).includes(trigger)
      ? t(`triggers.${trigger as TriggerKey}`)
      : trigger;
}
