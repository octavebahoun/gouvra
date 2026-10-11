import { Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import type { NavKey } from "@/components/layout/nav-items";
import { useDocumentTitle } from "@/lib/use-document-title";
import type { IllustrationName } from "@/components/brand/illustrations";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/feedback";
import { EmptyState, NotFoundState } from "@/components/ui/states";

type Section = Exclude<NavKey, "overview" | "settings">;

const SECTIONS: Record<Section, IllustrationName> = {
  agents: "agents",
  executions: "executions",
  tools: "tools",
  workflows: "workflows",
  evaluations: "evaluations",
  automations: "automations",
  usage: "usage",
  providers: "providers",
  connectors: "connectors",
  registry: "registry",
};

const isSection = (value: string | undefined): value is Section =>
  value !== undefined && value in SECTIONS;

/**
 * Sections whose features arrive in later phases: an honest description of what the page will
 * hold, with its illustration — no sample data, no fake numbers.
 */
export function InterimPage() {
  const { section } = useParams();
  if (!isSection(section)) return <NotFoundState headingLevel="h1" className="min-h-[60vh]" />;
  return <InterimSection section={section} />;
}

function InterimSection({ section }: { section: Section }) {
  const { t } = useTranslation(["shell", "common"]);
  const title = t(`common:nav.${section}`);
  useDocumentTitle(title);
  return (
    <PageContainer>
      <PageHeader
        title={title}
        description={t(`sections.${section}.description`)}
        meta={
          <Badge tone="outline" icon={<Clock3 aria-hidden />}>
            {t("sections.notAvailable")}
          </Badge>
        }
      />
      <Card>
        <EmptyState
          illustration={SECTIONS[section]}
          title={t(`sections.${section}.emptyTitle`)}
          description={t(`sections.${section}.emptyBody`)}
          className="py-16"
        />
      </Card>
    </PageContainer>
  );
}
