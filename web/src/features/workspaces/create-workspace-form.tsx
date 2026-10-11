import { zodResolver } from "@hookform/resolvers/zod";
import { Link2, PencilLine, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { hasErrorCode } from "@/lib/api/errors";
import { duration, ease } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useCreateWorkspace, type Workspace } from "./api";
import { SLUG_PATTERN, suggestedSlug, workspaceAddress } from "./slug";

type CreateWorkspaceFormProps = {
  id: string;
  onCreated: (workspace: Workspace) => void;
  /** Render the submit button(s); they submit the form through its id. */
  actions: (state: { pending: boolean }) => ReactNode;
};

/**
 * Name + URL. The URL follows the name (live preview) until the person chooses to customise it;
 * a generated URL is left to the API, which adds a suffix when it's taken.
 */
export function CreateWorkspaceForm({ id, onCreated, actions }: CreateWorkspaceFormProps) {
  const { t } = useTranslation("settings");
  const create = useCreateWorkspace();
  const [customSlug, setCustomSlug] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t("workspaceForm.nameRequired"))
          .min(2, t("workspaceForm.nameLength"))
          .max(80, t("workspaceForm.nameLength")),
        slug: z.string().trim(),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", slug: "" },
  });
  const name = useWatch({ control: form.control, name: "name" });
  const slug = useWatch({ control: form.control, name: "slug" });
  const preview = customSlug ? slug : suggestedSlug(name);

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    if (
      customSlug &&
      (values.slug.length < 3 || values.slug.length > 48 || !SLUG_PATTERN.test(values.slug))
    ) {
      form.setError("slug", { message: t("workspaceForm.slugInvalid") }, { shouldFocus: true });
      return;
    }
    try {
      const workspace = await create.mutateAsync({
        name: values.name,
        slug: customSlug ? values.slug : null,
      });
      onCreated(workspace);
    } catch (error) {
      if (hasErrorCode(error, "slug_unavailable")) {
        setCustomSlug(true);
        form.setValue("slug", suggestedSlug(values.name));
        form.setError(
          "slug",
          { message: t("workspaceForm.slugUnavailable") },
          { shouldFocus: true },
        );
        return;
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        if (fieldError.field === "slug") {
          return {
            field: "slug",
            message:
              fieldError.code === "taken"
                ? t("workspaceForm.slugTaken")
                : t("workspaceForm.slugInvalid"),
          };
        }
        if (fieldError.field === "name")
          return { field: "name", message: t("workspaceForm.nameLength") };
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  return (
    <form
      id={id}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-5"
    >
      {problem ? <FormProblemAlert error={problem} /> : null}
      <Field label={t("workspaceForm.name")} error={form.formState.errors.name?.message}>
        <Input
          aria-required
          autoComplete="organization"
          placeholder={t("workspaceForm.namePlaceholder")}
          maxLength={80}
          {...form.register("name")}
        />
      </Field>

      <AnimatePresence initial={false} mode="popLayout">
        {customSlug ? (
          <motion.div
            key="custom"
            initial={{ opacity: 0, y: -4 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { duration: duration.base, ease: ease.standard },
            }}
            exit={{ opacity: 0, transition: { duration: duration.fast } }}
          >
            <Field
              label={t("workspaceForm.slug")}
              description={t("workspaceForm.slugHelp")}
              error={form.formState.errors.slug?.message}
              hint={<AddressPreview slug={preview} />}
            >
              <Input
                aria-required
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                maxLength={48}
                {...form.register("slug", {
                  onChange: (event: { target: { value: string } }) => {
                    form.setValue("slug", event.target.value.toLowerCase().replace(/\s+/g, "-"));
                  },
                })}
              />
            </Field>
            <Button
              variant="link"
              size="sm"
              className="mt-2"
              leftIcon={<Undo2 aria-hidden />}
              onClick={() => {
                form.clearErrors("slug");
                setCustomSlug(false);
              }}
            >
              {t("workspaceForm.slugUseGenerated")}
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="auto"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: duration.base } }}
            exit={{ opacity: 0, transition: { duration: duration.fast } }}
            className="rounded-card border border-dashed border-line-strong/50 bg-surface-2/60 px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="text-[13px] font-medium text-ink">{t("workspaceForm.preview")}</p>
                <AddressPreview slug={preview} />
                <p className="text-xs text-muted">{t("workspaceForm.slugAuto")}</p>
              </div>
              <Button
                variant="tertiary"
                size="sm"
                className="shrink-0"
                leftIcon={<PencilLine aria-hidden />}
                onClick={() => {
                  form.setValue("slug", suggestedSlug(name));
                  setCustomSlug(true);
                  window.requestAnimationFrame(() => form.setFocus("slug"));
                }}
              >
                {t("workspaceForm.slugCustomize")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {actions({ pending: create.isPending })}
    </form>
  );
}

/** `host/w/slug` in monospace; the slug part animates as it changes. */
export function AddressPreview({ slug }: { slug: string }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-muted">
      <Link2 aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {workspaceAddress("")}
        <span className="text-ink">{slug || "…"}</span>
      </span>
    </p>
  );
}
