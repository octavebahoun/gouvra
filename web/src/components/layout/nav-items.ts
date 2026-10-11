import {
  Blocks,
  ChartColumn,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  Library,
  Play,
  Plug,
  Settings,
  Timer,
  Workflow,
  Wrench,
  Bot,
  type LucideIcon,
} from "lucide-react";

export type NavKey =
  | "overview"
  | "agents"
  | "executions"
  | "evaluations"
  | "workflows"
  | "tools"
  | "providers"
  | "automations"
  | "connectors"
  | "registry"
  | "usage"
  | "settings";

export type NavItem = { key: NavKey; path: string; Icon: LucideIcon };
export type NavGroup = { key: "main" | "build" | "operate" | "configure"; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  { key: "main", items: [{ key: "overview", path: "overview", Icon: LayoutDashboard }] },
  {
    key: "build",
    items: [
      { key: "agents", path: "agents", Icon: Bot },
      { key: "tools", path: "tools", Icon: Wrench },
      { key: "workflows", path: "workflows", Icon: Workflow },
      { key: "evaluations", path: "evaluations", Icon: FlaskConical },
    ],
  },
  {
    key: "operate",
    items: [
      { key: "executions", path: "executions", Icon: Play },
      { key: "automations", path: "automations", Icon: Timer },
      { key: "usage", path: "usage", Icon: ChartColumn },
    ],
  },
  {
    key: "configure",
    items: [
      { key: "providers", path: "providers", Icon: KeyRound },
      { key: "connectors", path: "connectors", Icon: Plug },
      { key: "registry", path: "registry", Icon: Library },
      { key: "settings", path: "settings", Icon: Settings },
    ],
  },
];

export const ADMIN_ICON = Blocks;
