import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/dialog";
import { Field, PrefixedInput } from "@/components/ui/field";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useSetBudget, type Budget } from "./api";

const THRESHOLDS = [50, 80, 90, 100];

export function BudgetDialog({
  open,
  onOpenChange,
  workspaceId,
  budget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  budget: Budget["budget"];
}) {
  const { t } = useTranslation(["billing", "common"]);
  const save = useSetBudget(workspaceId);
  const [amount, setAmount] = useState(budget ? String(Number(budget.monthly_limit)) : "");
  const [thresholds, setThresholds] = useState<number[]>(budget?.thresholds ?? [50, 80, 100]);
  const [hardStop, setHardStop] = useState(budget?.hard_stop ?? false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (value: number) =>
    setThresholds((current) =>
      current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value].sort((a, b) => a - b),
    );

  function submit(remove = false) {
    setError(null);
    const value = Number(amount.replace(",", "."));
    if (!remove && (!Number.isFinite(value) || value <= 0)) {
      setError(t("budget.invalid"));
      return;
    }
    save.mutate(
      remove
        ? { monthly_limit: null }
        : { monthly_limit: value.toFixed(2), thresholds, hard_stop: hardStop },
      {
        onSuccess: () => {
          toast.success(t(remove ? "budget.removed" : "budget.saved"));
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("budget.dialogTitle")}
      description={t("budget.dialogDescription")}
      footer={
        <>
          {budget ? (
            <Button variant="danger-ghost" className="sm:mr-auto" onClick={() => submit(true)}>
              {t("budget.remove")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => submit()} loading={save.isPending}>
            {t("common:actions.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {save.error ? <FormProblemAlert error={save.error} /> : null}
        <Field label={t("budget.amount")} hint={t("budget.amountHelp")} error={error} required>
          <PrefixedInput
            prefix="$"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink">
            {t("budget.thresholds")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {THRESHOLDS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={thresholds.includes(value)}
                onClick={() => toggle(value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                  thresholds.includes(value)
                    ? "border-brand bg-brand-soft text-brand-text"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                {value} %
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-muted">{t("budget.thresholdsHelp")}</p>
        </fieldset>
        <div className="flex items-start justify-between gap-4 text-[13px]">
          <span>
            <span id="hard-stop-label" className="block font-medium text-ink">
              {t("budget.hardStop")}
            </span>
            <span id="hard-stop-help" className="block text-muted">
              {t("budget.hardStopHelp")}
            </span>
          </span>
          <Switch
            checked={hardStop}
            onCheckedChange={setHardStop}
            aria-labelledby="hard-stop-label"
            aria-describedby="hard-stop-help"
          />
        </div>
      </div>
    </Dialog>
  );
}
