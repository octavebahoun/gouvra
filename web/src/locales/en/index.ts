import enAccount from "./account.json";
import enAdmin from "./admin.json";
import enAgents from "./agents.json";
import enAutomations from "./automations.json";
import enAuth from "./auth.json";
import enBilling from "./billing.json";
import enCommon from "./common.json";
import enConnectors from "./connectors.json";
import enEvaluations from "./evaluations.json";
import enExecutions from "./executions.json";
import enOnboarding from "./onboarding.json";
import enProviders from "./providers.json";
import enRegistry from "./registry.json";
import enSettings from "./settings.json";
import enShell from "./shell.json";
import enSite from "./site.json";
import enTools from "./tools.json";
import enUsage from "./usage.json";
import enWorkflows from "./workflows.json";

/** Every namespace of this language, loaded as one chunk when the language is used. */
const bundle = {
  account: enAccount,
  admin: enAdmin,
  agents: enAgents,
  automations: enAutomations,
  auth: enAuth,
  billing: enBilling,
  common: enCommon,
  connectors: enConnectors,
  evaluations: enEvaluations,
  executions: enExecutions,
  onboarding: enOnboarding,
  providers: enProviders,
  registry: enRegistry,
  settings: enSettings,
  shell: enShell,
  site: enSite,
  tools: enTools,
  usage: enUsage,
  workflows: enWorkflows,
};

export default bundle;
