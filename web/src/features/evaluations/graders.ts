import { useTranslation } from "react-i18next";
import type { GraderSpec, GraderType } from "./api";

export const GRADER_TYPES: GraderType[] = [
  "exact",
  "contains",
  "regex",
  "json_schema",
  "llm_judge",
];

export function defaultGrader(type: GraderType, providerId = "", model = ""): GraderSpec {
  switch (type) {
    case "exact":
      return { type, case_sensitive: false, trim: true, weight: 1 };
    case "contains":
      return { type, values: [""], mode: "all", case_sensitive: false, weight: 1 };
    case "regex":
      return { type, pattern: "", ignore_case: false, should_match: true, weight: 1 };
    case "json_schema":
      return { type, schema: { type: "object" }, weight: 1 };
    case "llm_judge":
      return { type, provider_id: providerId, model, rubric: "", pass_threshold: 0.7, weight: 1 };
  }
}

/** First problem that would make the API refuse these graders, or null. */
export function graderProblem(graders: GraderSpec[]): string | null {
  for (const grader of graders) {
    if (grader.type === "contains" && grader.values.every((v) => !v.trim())) return "values";
    if (grader.type === "regex" && !grader.pattern.trim()) return "pattern";
    if (grader.type === "llm_judge" && (grader.rubric.trim().length < 10 || !grader.provider_id)) {
      return "rubric";
    }
  }
  return null;
}

/** Compact, readable summary of graders (for tables). */
export function useGraderSummary() {
  const { t } = useTranslation("evaluations");
  return (graders: readonly Record<string, unknown>[] | null | undefined) =>
    (graders ?? [])
      .map((g) =>
        g.type === "contains"
          ? t("graders.summary.contains", { count: Array.isArray(g.values) ? g.values.length : 0 })
          : t(`graders.summary.${(g.type as GraderType | undefined) ?? "exact"}`),
      )
      .join(" · ");
}
