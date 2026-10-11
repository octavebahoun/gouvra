import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { duration, ease } from "@/components/motion/presets";

type FieldContextValue = { id: string; descriptionId: string; errorId: string; invalid: boolean };
const FieldContext = createContext<FieldContextValue | null>(null);

/** Read the ids of the surrounding <Field> so custom controls can wire ARIA themselves. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export const controlClass = cn(
  "block w-full rounded-field border border-line-strong/70 bg-surface px-3 text-sm text-ink shadow-sm",
  "transition-[border-color,box-shadow] duration-150 ease-standard",
  "hover:border-line-strong focus:border-brand focus:shadow-glow focus:outline-none",
  "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted",
  "aria-invalid:border-danger aria-invalid:focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--gv-danger)_18%,transparent)]",
);

type FieldProps = {
  label: ReactNode;
  /** Help text shown under the label. */
  description?: ReactNode;
  error?: string | null | undefined;
  required?: boolean;
  /** Visually hide the label (it stays available to assistive tech). */
  hideLabel?: boolean;
  className?: string;
  /** Extra content aligned to the right of the label (e.g. "Forgot password?"). */
  labelAside?: ReactNode;
  children: ReactElement<Record<string, unknown>>;
};

/**
 * Label + control + description + error, wired for assistive technologies:
 * the error is linked with aria-describedby / aria-invalid and announced when it appears.
 */
export function Field({
  label,
  description,
  error,
  required,
  hideLabel,
  className,
  labelAside,
  children,
}: FieldProps) {
  const { t } = useTranslation();
  const generated = useId();
  const childId = isValidElement(children) ? (children.props.id as string | undefined) : undefined;
  const id = childId ?? generated;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);
  const describedBy = [description ? descriptionId : null, invalid ? errorId : null]
    .filter(Boolean)
    .join(" ");

  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        "aria-invalid": invalid || undefined,
        "aria-describedby": describedBy || undefined,
        "aria-required": required ? true : undefined,
      })
    : children;

  return (
    <FieldContext.Provider value={{ id, descriptionId, errorId, invalid }}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        <div className={cn("flex items-baseline justify-between gap-3", hideLabel && "sr-only")}>
          <label htmlFor={id} className="text-[13px] font-medium text-ink">
            {label}
            {required ? (
              <span className="ml-0.5 text-danger-text" aria-hidden>
                *
              </span>
            ) : null}
            {required ? <span className="sr-only"> ({t("form.required")})</span> : null}
          </label>
          {labelAside}
        </div>
        {description ? (
          <p id={descriptionId} className="-mt-0.5 text-[13px] text-muted">
            {description}
          </p>
        ) : null}
        {control}
        <AnimatePresence initial={false}>
          {invalid ? (
            <motion.p
              key="error"
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-[13px] text-danger-text"
              initial={{ opacity: 0, y: -4 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: { duration: duration.fast, ease: ease.standard },
              }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </FieldContext.Provider>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClass, "h-9", className)} {...props} />;
}

export function Textarea({ className, rows = 4, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={rows}
      className={cn(controlClass, "min-h-20 resize-y py-2 leading-relaxed", className)}
      {...props}
    />
  );
}

export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={cn(controlClass, "h-9 pr-10", className)}
        autoCapitalize="none"
        spellCheck={false}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-field text-muted transition-colors hover:text-ink"
        aria-label={visible ? t("form.hidePassword") : t("form.showPassword")}
        aria-pressed={visible}
      >
        {visible ? (
          <EyeOff aria-hidden className="size-4" />
        ) : (
          <Eye aria-hidden className="size-4" />
        )}
      </button>
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-field border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
