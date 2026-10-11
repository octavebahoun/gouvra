import { CircleAlert, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { hasErrorCode } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Button, IconButton } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useDiagnosis } from "@/features/executions/diagnosis";
import {
  useDeleteProvider,
  useProviders,
  useTestProvider,
  type Provider,
  type ProviderKindId,
} from "./api";
import { ProviderDialog } from "./provider-dialog";
import { ProviderMark, ProviderStatus } from "./provider-visual";

/** Screen O — the workspace's model providers: status, default model, safe key handling. */
export function ProvidersPage() {
  const { t } = useTranslation(["providers", "common"]);
  const { workspace, detail } = useCurrentWorkspace();
  const providers = useProviders(workspace.id);
  const manage = can(detail.data, "providers:manage");
  const [dialog, setDialog] = useState<{
    provider: Provider | null;
    kind?: ProviderKindId;
  } | null>(null);
  const [session, setSession] = useState(0);
  const open = (next: { provider: Provider | null; kind?: ProviderKindId }) => {
    setSession((value) => value + 1);
    setDialog(next);
  };
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const openCreate = (kind?: ProviderKindId) => open({ provider: null, kind });

  return (
    <PageContainer>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          manage && providers.data && providers.data.length > 0 ? (
            <Button leftIcon={<Plus aria-hidden />} onClick={() => openCreate()}>
              {t("add")}
            </Button>
          ) : null
        }
      />
      {!manage && detail.data ? (
        <Alert tone="info" title={t("noPermission")} className="mb-5" />
      ) : null}
      {providers.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-card" />
          ))}
        </div>
      ) : providers.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={providers.error}
            onRetry={() => void providers.refetch()}
          />
        </Card>
      ) : providers.data.length === 0 ? (
        <Card>
          <EmptyState
            illustration="providers"
            title={t("empty.title")}
            description={t("empty.body")}
            action={
              manage ? (
                <Button leftIcon={<Plus aria-hidden />} onClick={() => openCreate()}>
                  {t("add")}
                </Button>
              ) : undefined
            }
            secondaryAction={
              manage ? (
                <Button variant="secondary" onClick={() => openCreate("test")}>
                  {t("empty.offline")}
                </Button>
              ) : undefined
            }
            className="py-16"
          />
        </Card>
      ) : (
        <motion.ul
          variants={staggerChildren(0.05)}
          initial="hidden"
          animate="visible"
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          <AnimatePresence initial={false}>
            {providers.data.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                workspaceId={workspace.id}
                manage={manage}
                onEdit={() => open({ provider })}
              />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
      {manage ? (
        <ProviderDialog
          key={session}
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          workspaceId={workspace.id}
          provider={dialog?.provider ?? null}
          initialKind={dialog?.kind}
        />
      ) : null}
    </PageContainer>
  );
}

function ProviderCard({
  provider,
  workspaceId,
  manage,
  onEdit,
}: {
  provider: Provider;
  workspaceId: string;
  manage: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation(["providers", "common"]);
  const { relative } = useFormatters();
  const test = useTestProvider(workspaceId);
  const remove = useDeleteProvider(workspaceId);
  const diagnose = useDiagnosis();
  const [deleting, setDeleting] = useState(false);
  const failure = provider.status === "error" && provider.last_error ? provider.last_error : null;
  const explained = failure ? diagnose(failure.code) : null;

  const runTest = () =>
    test.mutate(provider.id, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success(t("test.ok", { name: provider.name }), {
            description: t("test.okDetail", { count: result.models.length, ms: result.latency_ms }),
          });
        } else {
          const why = diagnose(result.error?.code ?? "provider_invalid_response");
          toast.error(t("test.failed", { name: provider.name }), { description: why.title });
        }
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <motion.li variants={listItem} layout exit={{ opacity: 0, scale: 0.97 }}>
      <Card className="flex h-full flex-col">
        <div className="flex items-start gap-3 px-5 pt-5">
          <ProviderMark kind={provider.kind} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">{provider.name}</h2>
            <p className="text-[13px] text-muted">{provider.kind_label}</p>
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={`${provider.status}-${provider.last_tested_at ?? ""}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
            >
              <ProviderStatus provider={provider} />
            </motion.span>
          </AnimatePresence>
        </div>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-5 text-[13px]">
          <dt className="text-muted">{t("card.defaultModel")}</dt>
          <dd className="truncate text-right font-mono text-ink">
            {provider.default_model ?? t("card.noDefaultModel")}
          </dd>
          <dt className="text-muted">{t("card.models")}</dt>
          <dd className="text-right text-ink tabular-nums">
            {t("card.modelsCount", { count: provider.models.length })}
          </dd>
          <dt className="text-muted">{t("card.key")}</dt>
          <dd className="flex items-center justify-end gap-1.5 text-ink">
            {provider.kind === "test" ? (
              <span className="text-muted">{t("card.noKey")}</span>
            ) : provider.secret_set ? (
              <>
                <KeyRound aria-hidden className="size-3.5 text-muted" />
                <span className="font-mono">
                  {t("card.keyEnding", { hint: provider.secret_hint ?? "••••" })}
                </span>
              </>
            ) : (
              <span className="text-danger-text">{t("card.missingKey")}</span>
            )}
          </dd>
          <dt className="text-muted">{t("card.usage")}</dt>
          <dd className="text-right text-ink tabular-nums">
            {t("card.usedBy", { count: provider.agent_count })}
          </dd>
        </dl>

        {failure && explained ? (
          <div className="mx-5 mt-4 flex gap-2 rounded-field bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">{explained.title}</p>
              <p className="mt-0.5 opacity-90">{explained.action}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-auto flex items-center gap-2 border-t border-line px-5 py-3 pt-3">
          <p className="mr-auto text-xs text-muted">
            {provider.last_tested_at
              ? t("card.lastTested", { when: relative(provider.last_tested_at) })
              : t("card.neverTested")}
          </p>
          {manage ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={test.isPending}
                leftIcon={<RefreshCw aria-hidden />}
                onClick={runTest}
              >
                {test.isPending ? t("card.testing") : t("card.test")}
              </Button>
              <IconButton
                size="icon-sm"
                label={t("card.edit", { name: provider.name })}
                icon={<Pencil aria-hidden />}
                onClick={onEdit}
              />
              <IconButton
                size="icon-sm"
                variant="danger-ghost"
                label={t("card.delete", { name: provider.name })}
                icon={<Trash2 aria-hidden />}
                onClick={() => setDeleting(true)}
              />
            </>
          ) : null}
        </div>
      </Card>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("remove.title", { name: provider.name })}
        description={t("remove.body")}
        confirmLabel={t("remove.confirm")}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(provider.id, {
            onSuccess: () => {
              setDeleting(false);
              toast.success(t("remove.deleted", { name: provider.name }));
            },
            onError: (error) => {
              setDeleting(false);
              toast.error(
                hasErrorCode(error, "provider_in_use")
                  ? t("remove.inUse", { count: provider.agent_count, name: provider.name })
                  : error.message,
              );
            },
          })
        }
      />
    </motion.li>
  );
}
