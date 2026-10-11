import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { duration, ease, spring } from "@/components/motion/presets";
import { Button } from "./button";
import { Field, Input } from "./field";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Destructive dialogs ignore Escape / outside clicks so the choice is always explicit. */
  dismissible?: boolean;
  className?: string;
};

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

/**
 * Accessible modal: title + description, focus trapped, initial focus inside,
 * focus restored to the trigger on close. Animated with transform/opacity only.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  className,
}: DialogProps) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: duration.base } }}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
              />
            </DialogPrimitive.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
              <DialogPrimitive.Content
                asChild
                forceMount
                onOpenAutoFocus={(event) => {
                  // Start where the work is: a marked control, else the first field, else the
                  // least destructive footer action (Cancel) — never the close button.
                  const root = event.currentTarget as HTMLElement | null;
                  const target =
                    root?.querySelector<HTMLElement>("[data-autofocus]") ??
                    root?.querySelector<HTMLElement>(
                      "input:not([type=hidden]):not([disabled]), textarea, select, [role=combobox]",
                    ) ??
                    root?.querySelector<HTMLElement>("[data-dialog-footer] button:not([disabled])");
                  if (target) {
                    event.preventDefault();
                    target.focus();
                  }
                }}
                onEscapeKeyDown={(event) => {
                  if (!dismissible) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (!dismissible) event.preventDefault();
                }}
                {...(description ? {} : { "aria-describedby": undefined })}
              >
                <motion.div
                  className={cn(
                    "pointer-events-auto relative flex max-h-[min(90dvh,56rem)] w-full flex-col overflow-hidden",
                    "rounded-t-panel border border-line bg-surface shadow-lg sm:rounded-panel",
                    SIZES[size],
                    className,
                  )}
                  initial={{ opacity: 0, y: 24, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: spring.snappy }}
                  exit={{
                    opacity: 0,
                    y: 12,
                    scale: 0.98,
                    transition: { duration: duration.fast, ease: ease.exit },
                  }}
                >
                  <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
                    <div className="min-w-0 space-y-1">
                      <DialogPrimitive.Title className="text-base font-semibold text-ink">
                        {title}
                      </DialogPrimitive.Title>
                      {description ? (
                        <DialogPrimitive.Description className="text-[13px] leading-relaxed text-muted">
                          {description}
                        </DialogPrimitive.Description>
                      ) : null}
                    </div>
                    {dismissible ? (
                      <DialogPrimitive.Close asChild>
                        <Button variant="tertiary" size="icon-sm" aria-label={t("a11y.close")}>
                          <X aria-hidden />
                        </Button>
                      </DialogPrimitive.Close>
                    ) : null}
                  </div>
                  {children ? (
                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">{children}</div>
                  ) : null}
                  {footer ? (
                    <div
                      data-dialog-footer
                      className="flex flex-col-reverse gap-2 border-t border-line bg-surface-2/50 px-6 py-3 sm:flex-row sm:justify-end"
                    >
                      {footer}
                    </div>
                  ) : null}
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  /** When set, the user must type this exact name to confirm (deletions, revocations). */
  resourceName?: string;
  tone?: "danger" | "primary";
  pending?: boolean;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  resourceName,
  tone = "danger",
  pending = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const blocked = resourceName !== undefined && typed.trim() !== resourceName;
  const close = (next: boolean) => {
    if (!next) setTyped("");
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={blocked}
            loading={pending}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {resourceName !== undefined ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) void onConfirm();
          }}
          className="pb-2"
        >
          <Field label={t("confirm.typeName", { name: resourceName })}>
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              data-autofocus
            />
          </Field>
        </form>
      ) : null}
    </Dialog>
  );
}
