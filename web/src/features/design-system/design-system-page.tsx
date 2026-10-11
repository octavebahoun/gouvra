import { Plus, Play, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Logo } from "@/components/brand/logo";
import { Illustration, type IllustrationName } from "@/components/brand/illustrations";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { ThemeToggle } from "@/components/layout/shell-parts";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge, StatusBadge, type ExecutionStatus } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, Select, Switch } from "@/components/ui/controls";
import { CopyButton, IdChip } from "@/components/ui/copy-button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Alert, Card, CardHeader, Kbd, Skeleton } from "@/components/ui/feedback";
import { Field, Input, PasswordInput, Textarea } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/errors";

const SWATCHES = [
  "canvas",
  "surface",
  "surface-2",
  "sunken",
  "ink",
  "muted",
  "line",
  "line-strong",
  "brand",
  "brand-soft",
  "success",
  "success-soft",
  "warning",
  "warning-soft",
  "danger",
  "danger-soft",
];
const STATUSES: ExecutionStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];
const ILLUSTRATIONS: IllustrationName[] = [
  "agents",
  "executions",
  "tools",
  "providers",
  "evaluations",
  "workflows",
  "usage",
  "automations",
  "members",
  "error",
  "locked",
  "not-found",
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="p-5">{children}</div>
    </Card>
  );
}

/** Living reference of the design system (tokens, components, states). Sample content only. */
export function DesignSystemPage() {
  const { t } = useTranslation();
  const [cycle, setCycle] = useState(1);
  const [tokens, setTokens] = useState(1280);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tab, setTab] = useState("timeline");
  const [model, setModel] = useState<string | undefined>("deepseek-chat");
  const [enabled, setEnabled] = useState(true);
  const status = STATUSES[cycle % STATUSES.length] ?? "running";

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4 sm:px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <PageContainer>
        <PageHeader
          title="Design system"
          description="Tokens, components and states used across Gouvra. Every value on this page is example content."
          breadcrumbs={[{ label: "Gouvra", to: "/" }, { label: "Design system" }]}
          meta={<Badge tone="outline">Example data</Badge>}
          actions={
            <Button
              leftIcon={<Plus aria-hidden />}
              onClick={() => toast.success("Agent created", { description: "Support triage · v1" })}
            >
              Trigger a toast
            </Button>
          }
        />
        <div className="grid gap-6">
          <Section title="Colour tokens">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {SWATCHES.map((name) => (
                <div key={name} className="space-y-1.5">
                  <div
                    className="h-12 rounded-field border border-line"
                    style={{ background: `var(--gv-${name})` }}
                  />
                  <p className="font-mono text-[11px] text-muted">{name}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Typography">
            <div className="space-y-2">
              <p className="text-xl font-semibold tracking-[-0.01em]">Page title — Inter 20/600</p>
              <p className="text-[15px] font-semibold">Section title — Inter 15/600</p>
              <p className="text-sm">Body — Inter 14/400. Precise, calm and readable.</p>
              <p className="text-[13px] text-muted">Help text — 13/400 muted</p>
              <p className="font-mono text-xs">
                exe_01J9Z… · {"{"}"tokens": 1280{"}"} — JetBrains Mono
              </p>
              <p className="tabular-nums">Tabular figures: 1 111 · 8 888 · 0.0042 $</p>
            </div>
          </Section>

          <Section title="Buttons">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="tertiary">Tertiary</Button>
              <Button variant="danger" leftIcon={<Trash2 aria-hidden />}>
                Delete
              </Button>
              <Button loading>Launching</Button>
              <Button disabled>Disabled</Button>
              <Button variant="link">Link</Button>
              <IconButton label="Run" icon={<Play aria-hidden />} variant="secondary" />
              <Button size="sm">Small</Button>
              <Button size="lg">Large</Button>
            </div>
          </Section>

          <Section title="Execution states">
            <div className="flex flex-wrap items-center gap-3">
              {STATUSES.map((s) => (
                <StatusBadge key={s} status={s} />
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-line pt-5">
              <span className="text-[13px] text-muted">Live transition:</span>
              <StatusBadge status={status} />
              <Button size="sm" variant="secondary" onClick={() => setCycle((c) => c + 1)}>
                Next state
              </Button>
              <span className="text-[13px] text-muted">Tokens:</span>
              <AnimatedNumber value={tokens} className="font-mono text-sm" />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setTokens((v) => v + Math.round(Math.random() * 900))}
              >
                Add tokens
              </Button>
            </div>
          </Section>

          <Section title="Badges & identifiers">
            <div className="flex flex-wrap items-center gap-3">
              <Badge>Neutral</Badge>
              <Badge tone="brand">Brand</Badge>
              <Badge tone="success">Success</Badge>
              <Badge tone="warning">Quota at 82%</Badge>
              <Badge tone="danger">Danger</Badge>
              <Badge tone="outline">Outline</Badge>
              <IdChip id="0199d2c4-8f1e-7c3a-9b2d-5e6f7a8b9c0d" label="execution ID" />
              <CopyButton value="sample" label="sample value" showText />
              <span className="text-[13px] text-muted">
                Press <Kbd>⌘</Kbd> <Kbd>K</Kbd>
              </span>
              <Tooltip content="Tooltips only add context; nothing essential hides here.">
                <Button size="sm" variant="tertiary">
                  Hover or focus me
                </Button>
              </Tooltip>
            </div>
          </Section>

          <Section title="Form controls">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Agent name" description="Shown in lists and traces." required>
                <Input placeholder="Support triage" />
              </Field>
              <Field label="E-mail" error="Enter a valid e-mail address.">
                <Input type="email" defaultValue="jane@" />
              </Field>
              <Field label="Password">
                <PasswordInput defaultValue="correct horse battery staple" />
              </Field>
              <Field label="Model">
                <Select
                  value={model}
                  onValueChange={setModel}
                  options={[
                    {
                      value: "deepseek-chat",
                      label: "deepseek-chat",
                      description: "DeepSeek · tools, JSON",
                    },
                    {
                      value: "claude-sonnet",
                      label: "claude-sonnet",
                      description: "Anthropic · tools",
                    },
                  ]}
                />
              </Field>
              <Field label="Instructions" className="md:col-span-2">
                <Textarea defaultValue="You are a careful support assistant." />
              </Field>
              <div className="flex items-center gap-3">
                <Switch id="ds-switch" checked={enabled} onCheckedChange={setEnabled} />
                <label htmlFor="ds-switch" className="text-sm">
                  Allow the HTTP tool
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox id="ds-check" defaultChecked />
                <label htmlFor="ds-check" className="text-sm">
                  I understand this tool can reach the network
                </label>
              </div>
            </div>
          </Section>

          <Section title="Alerts">
            <div className="grid gap-3">
              <Alert tone="info" title="Costs are estimated">
                DeepSeek does not report cost; Gouvra estimates it from tokens and the registry
                price.
              </Alert>
              <Alert tone="success" title="Provider connected" />
              <Alert tone="warning" title="82% of the monthly budget used" />
              <Alert
                tone="danger"
                title="The provider rejected the API key"
                action={
                  <Button size="sm" variant="secondary">
                    Update key
                  </Button>
                }
              >
                Check the key in Providers, then retry the execution.
              </Alert>
            </div>
          </Section>

          <Section title="Tabs, dialogs, loading">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList
                value={tab}
                items={[
                  { value: "timeline", label: "Timeline", count: 12 },
                  { value: "output", label: "Output" },
                  { value: "input", label: "Input" },
                ]}
              />
              <TabsContent value="timeline" className="pt-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-16 w-full" />
                </div>
              </TabsContent>
              <TabsContent value="output" className="pt-4 text-sm text-muted">
                Final answer would appear here.
              </TabsContent>
              <TabsContent value="input" className="pt-4 text-sm text-muted">
                Input payload.
              </TabsContent>
            </Tabs>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Open dialog
              </Button>
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                Delete agent…
              </Button>
            </div>
            <Dialog
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              title="Launch an execution"
              description="The agent runs asynchronously; you can follow it live."
              footer={
                <>
                  <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                    {t("actions.cancel")}
                  </Button>
                  <Button onClick={() => setDialogOpen(false)}>Launch</Button>
                </>
              }
            >
              <Field label="Input">
                <Textarea placeholder="Summarise the last 3 tickets" />
              </Field>
            </Dialog>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title="Delete “support-triage”?"
              description="Its executions stay in history. This cannot be undone."
              confirmLabel="Delete agent"
              resourceName="support-triage"
              onConfirm={() => setConfirmOpen(false)}
            />
          </Section>

          <Section title="Empty, error and access states">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <EmptyState
                  illustration="agents"
                  title="No agents yet"
                  description="Create an agent, pick a model and choose which tools it may use."
                  action={<Button leftIcon={<Plus aria-hidden />}>Create an agent</Button>}
                />
              </Card>
              <Card>
                <ErrorState
                  error={
                    new ApiError({
                      status: 500,
                      code: "internal_error",
                      request_id: "0199d2c48f1e7c3a",
                    })
                  }
                  onRetry={() => undefined}
                />
              </Card>
            </div>
            <div className="mt-6 grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
              {ILLUSTRATIONS.map((name) => (
                <div
                  key={name}
                  className="flex flex-col items-center gap-1 rounded-card border border-line p-3"
                >
                  <Illustration name={name} className="h-16 w-24" />
                  <span className="font-mono text-[11px] text-muted">{name}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </PageContainer>
    </div>
  );
}
