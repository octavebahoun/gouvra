import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  GitBranch,
  Hash,
  MessageCircle,
  Pencil,
  Plug,
  Send,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/states";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  useCheckConnection,
  useConnections,
  useConnectorLibrary,
  useCreateConnection,
  useRemoveConnection,
  useUpdateConnection,
  type Connection,
  type Connector,
} from "./api";

const ICONS: Record<string, LucideIcon> = {
  slack: Hash,
  discord: MessageCircle,
  github: GitBranch,
  webhook: Send,
};

function ConnectorIcon({ connector }: { connector: string }) {
  const Icon = ICONS[connector] ?? Plug;
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink"
    >
      <Icon className="size-5" />
    </span>
  );
}

/** Connectors: services agents can act on, through tools built from each connection. */
export function ConnectorsPage() {
  const { t } = useTranslation(["connectors", "common"]);
  const { workspace, detail } = useCurrentWorkspace();
  const library = useConnectorLibrary();
  const connections = useConnections(workspace.id);
  const manage = can(detail.data, "connectors:manage");
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  return (
    <PageContainer wide>
      <PageHeader title={t("title")} description={t("description")} />
      {!manage && detail.data ? <Alert tone="info" title={t("readOnly")} className="mb-5" /> : null}

      <section aria-labelledby="connections-title" className="mb-8">
        <h2 id="connections-title" className="mb-3 text-[15px] font-semibold text-ink">
          {t("connections.title")}
        </h2>
        {connections.isPending ? (
          <Skeleton className="h-28 rounded-card" />
        ) : connections.isError ? (
          <Card>
            <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
          </Card>
        ) : connections.data.length === 0 ? (
          <Card>
            <p className="px-5 py-8 text-center text-[13px] text-muted">{t("connections.empty")}</p>
          </Card>
        ) : (
          <motion.ul
            variants={staggerChildren(0.04)}
            initial="hidden"
            animate="visible"
            className="grid gap-3 lg:grid-cols-2"
          >
            {connections.data.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                manage={manage}
                workspaceId={workspace.id}
                onEdit={() => setEditing(connection)}
              />
            ))}
          </motion.ul>
        )}
      </section>

      <section aria-labelledby="library-title">
        <h2 id="library-title" className="mb-1 text-[15px] font-semibold text-ink">
          {t("library.title")}
        </h2>
        <p className="mb-3 text-[13px] text-muted">{t("library.description")}</p>
        {library.isPending ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-52 rounded-card" />
            ))}
          </div>
        ) : library.isError ? (
          <Card>
            <ErrorState error={library.error} onRetry={() => void library.refetch()} />
          </Card>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {library.data.map((connector) => (
              <li
                key={connector.key}
                className="flex flex-col rounded-card border border-line bg-surface p-4 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <ConnectorIcon connector={connector.key} />
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold text-ink">{connector.name}</h3>
                    <p className="text-[12px] text-muted">
                      {t(`category.${connector.category as "messaging"}`)}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[13px] text-muted">{connector.description}</p>
                <ul className="mt-3 space-y-1 text-[13px] text-ink">
                  {connector.operations.map((operation) => (
                    <li key={operation.key} className="flex items-center gap-2">
                      <span aria-hidden className="size-1.5 rounded-full bg-line-strong" />
                      {operation.name}
                      {operation.writes ? null : (
                        <Badge tone="outline" className="h-5 px-1.5 text-[10px]">
                          {t("library.readOnly")}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <a
                    href={connector.docs_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink hover:underline"
                  >
                    <BookOpen aria-hidden className="size-3.5" />
                    {t("library.docs")}
                    <span className="sr-only"> ({t("common:a11y.newTab")})</span>
                  </a>
                  {manage ? (
                    <Button size="sm" onClick={() => setConnecting(connector)}>
                      {t("library.connect")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {connecting ? (
        <ConnectDialog
          connector={connecting}
          workspaceId={workspace.id}
          onClose={() => setConnecting(null)}
        />
      ) : null}
      {editing && library.data ? (
        <EditConnectionDialog
          connection={editing}
          connector={library.data.find((c) => c.key === editing.connector)}
          workspaceId={workspace.id}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </PageContainer>
  );
}

function StatusLine({ connection }: { connection: Connection }) {
  const { t } = useTranslation("connectors");
  const { relative } = useFormatters();
  const tone =
    connection.status === "ok" ? "success" : connection.status === "error" ? "danger" : "neutral";
  const Icon =
    connection.status === "ok"
      ? CircleCheck
      : connection.status === "error"
        ? CircleAlert
        : CircleDashed;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
      <Badge tone={tone} icon={<Icon aria-hidden />}>
        {t(`status.${connection.status}`)}
      </Badge>
      {connection.last_checked_at ? (
        <span className="text-muted">{relative(connection.last_checked_at)}</span>
      ) : null}
      {connection.status_message ? (
        <span className="w-full text-[13px] text-muted">{connection.status_message}</span>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  connection,
  manage,
  workspaceId,
  onEdit,
}: {
  connection: Connection;
  manage: boolean;
  workspaceId: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation("connectors");
  const check = useCheckConnection(workspaceId);
  const remove = useRemoveConnection(workspaceId);
  const [confirming, setConfirming] = useState(false);
  return (
    <motion.li
      variants={listItem}
      className="rounded-card border border-line bg-surface p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon connector={connection.connector} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-ink">{connection.name}</h3>
          <p className="text-[12px] text-muted">
            {connection.connector_name}
            {connection.secret_hint ? ` · ••••${connection.secret_hint}` : ""}
          </p>
        </div>
        <span className="text-[12px] text-muted">
          {t("connections.agents", { count: connection.agent_count })}
        </span>
      </div>
      <StatusLine connection={connection} />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {connection.tools.map((tool) => (
          <Badge key={tool.id} tone="outline" className="font-mono text-[11px]">
            {tool.name}
          </Badge>
        ))}
      </div>
      {manage ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<ShieldCheck aria-hidden />}
            loading={check.isPending}
            onClick={() =>
              check.mutate(connection.id, {
                onSuccess: (result) =>
                  result.ok ? toast.success(result.message) : toast.error(result.message),
              })
            }
          >
            {t("connections.check")}
          </Button>
          <Button size="sm" variant="tertiary" leftIcon={<Pencil aria-hidden />} onClick={onEdit}>
            {t("connections.edit")}
          </Button>
          <Button
            size="sm"
            variant="danger-ghost"
            leftIcon={<Trash2 aria-hidden />}
            onClick={() => setConfirming(true)}
          >
            {t("connections.remove")}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("connections.removeTitle", { name: connection.name })}
        description={t("connections.removeBody", { count: connection.agent_count })}
        confirmLabel={t("connections.remove")}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(connection.id, {
            onSuccess: () => {
              setConfirming(false);
              toast.success(t("connections.removed"));
            },
          })
        }
      />
    </motion.li>
  );
}

function CredentialFields({
  connector,
  values,
  onChange,
  errors,
  optionalNote,
}: {
  connector: Connector;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  errors: Record<string, string>;
  optionalNote?: string;
}) {
  return (
    <>
      {connector.fields.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          hint={field.help}
          description={optionalNote}
          required={field.required}
          error={errors[`credentials.${field.key}`]}
        >
          <PasswordInput
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        </Field>
      ))}
    </>
  );
}

function fieldErrorsOf(error: unknown): Record<string, string> | null {
  if (!isApiError(error) || error.fieldErrors.length === 0) return null;
  return Object.fromEntries(error.fieldErrors.map((e) => [e.field, e.message]));
}

function ConnectDialog({
  connector,
  workspaceId,
  onClose,
}: {
  connector: Connector;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["connectors", "common"]);
  const create = useCreateConnection(workspaceId);
  const check = useCheckConnection(workspaceId);
  const [name, setName] = useState(connector.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);

  async function submit() {
    setProblem(null);
    setErrors({});
    try {
      const connection = await create.mutateAsync({
        connector: connector.key,
        name,
        credentials: values,
      });
      toast.success(
        t("connect.created", { name: connection.name, count: connection.tools.length }),
      );
      onClose();
      if (connector.verifiable) {
        check.mutate(connection.id, {
          onSuccess: (result) =>
            result.ok ? toast.success(result.message) : toast.error(result.message),
        });
      }
    } catch (error) {
      const placed = fieldErrorsOf(error);
      if (placed) setErrors(placed);
      else setProblem(error);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("connect.title", { name: connector.name })}
      description={t("connect.description")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={create.isPending}>
            {t("connect.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("connect.name")} hint={t("connect.nameHelp")} error={errors.name} required>
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <CredentialFields
          connector={connector}
          values={values}
          errors={errors}
          onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
        />
        <p className="text-[12px] leading-relaxed text-muted">
          {t("connect.tools", { tools: connector.operations.map((o) => o.name).join(", ") })}
        </p>
      </div>
    </Dialog>
  );
}

function EditConnectionDialog({
  connection,
  connector,
  workspaceId,
  onClose,
}: {
  connection: Connection;
  connector: Connector | undefined;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["connectors", "common"]);
  const update = useUpdateConnection(workspaceId, connection.id);
  const [name, setName] = useState(connection.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const replacing = Object.values(values).some((value) => value.trim());

  async function submit() {
    setProblem(null);
    setErrors({});
    try {
      await update.mutateAsync({ name, ...(replacing ? { credentials: values } : {}) });
      toast.success(t("edit.saved"));
      onClose();
    } catch (error) {
      const placed = fieldErrorsOf(error);
      if (placed) setErrors(placed);
      else setProblem(error);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("edit.title", { name: connection.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={update.isPending}>
            {t("common:actions.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("connect.name")} error={errors.name} required>
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        {connector ? (
          <fieldset className="space-y-4">
            <legend className="text-[13px] font-medium text-ink">{t("edit.replace")}</legend>
            <p className="text-[12px] text-muted">{t("edit.replaceHelp")}</p>
            <CredentialFields
              connector={connector}
              values={values}
              errors={errors}
              onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
            />
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}
