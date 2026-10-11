import frAccount from "./account.json";
import frAgents from "./agents.json";
import frAuth from "./auth.json";
import frCommon from "./common.json";
import frEvaluations from "./evaluations.json";
import frExecutions from "./executions.json";
import frOnboarding from "./onboarding.json";
import frProviders from "./providers.json";
import frSettings from "./settings.json";
import frShell from "./shell.json";
import frSite from "./site.json";
import frTools from "./tools.json";
import frUsage from "./usage.json";

/** Every namespace of this language, loaded as one chunk when the language is used. */
const bundle = {
  account: frAccount,
  agents: frAgents,
  auth: frAuth,
  common: frCommon,
  evaluations: frEvaluations,
  executions: frExecutions,
  onboarding: frOnboarding,
  providers: frProviders,
  settings: frSettings,
  shell: frShell,
  site: frSite,
  tools: frTools,
  usage: frUsage,
};

export default bundle;
