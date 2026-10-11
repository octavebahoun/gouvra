import { createBrowserRouter, Navigate } from "react-router";
import { captureFragmentToken } from "@/lib/auth/fragment-token";
import { GuestOnly, RequireAuth, RequireVerified } from "@/lib/auth/guards";
import { PageLoader } from "@/components/layout/page-loader";
import { RootLayout } from "./root-layout";
import { RouteError } from "./route-error";

// E-mail links carry one-time tokens in the fragment: take them before the router starts.
captureFragmentToken();

/**
 * Routes are lazy-loaded per feature (one chunk each). Every screen of the UI inventory
 * (A–T) has a route here; permissions are enforced by the API and reflected by the UI.
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <PageLoader className="min-h-dvh" />,
    children: [
      // A — public site
      {
        index: true,
        lazy: () =>
          import("@/features/public/landing-page").then((m) => ({ Component: m.LandingPage })),
      },
      {
        path: "design-system",
        lazy: () =>
          import("@/features/design-system/design-system-page").then((m) => ({
            Component: m.DesignSystemPage,
          })),
      },

      // B–E — sign-up, sign-in, recovery and e-mail links (split layout)
      {
        lazy: () =>
          import("@/features/auth/auth-layout").then((m) => ({ Component: m.AuthLayout })),
        children: [
          {
            element: <GuestOnly />,
            children: [
              {
                path: "login",
                lazy: () =>
                  import("@/features/auth/login-page").then((m) => ({ Component: m.LoginPage })),
              },
              {
                path: "register",
                lazy: () =>
                  import("@/features/auth/register-page").then((m) => ({
                    Component: m.RegisterPage,
                  })),
              },
              {
                path: "forgot-password",
                lazy: () =>
                  import("@/features/auth/forgot-password-page").then((m) => ({
                    Component: m.ForgotPasswordPage,
                  })),
              },
            ],
          },
          {
            path: "verify-email",
            lazy: () =>
              import("@/features/auth/verify-email-page").then((m) => ({
                Component: m.VerifyEmailPage,
              })),
          },
          {
            path: "reset-password",
            lazy: () =>
              import("@/features/auth/reset-password-page").then((m) => ({
                Component: m.ResetPasswordPage,
              })),
          },
          {
            path: "confirm-email",
            lazy: () =>
              import("@/features/auth/confirm-email-page").then((m) => ({
                Component: m.ConfirmEmailPage,
              })),
          },
          {
            path: "invite",
            lazy: () =>
              import("@/features/workspaces/invite-page").then((m) => ({
                Component: m.InvitePage,
              })),
          },
        ],
      },

      // Signed-in, confirmed accounts
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireVerified />,
            children: [
              {
                path: "app",
                lazy: () =>
                  import("@/features/workspaces/app-redirect").then((m) => ({
                    Component: m.AppRedirect,
                  })),
              },
              // F — onboarding
              {
                path: "onboarding",
                lazy: () =>
                  import("@/features/onboarding/onboarding-page").then((m) => ({
                    Component: m.OnboardingPage,
                  })),
              },
              // R — profile & preferences
              {
                path: "account",
                lazy: () =>
                  import("@/features/account/account-route").then((m) => ({
                    Component: m.AccountRoute,
                  })),
              },
              // Workspace app shell
              {
                path: "w/:slug",
                lazy: () =>
                  import("@/features/workspaces/workspace-layout").then((m) => ({
                    Component: m.WorkspaceLayout,
                  })),
                children: [
                  { index: true, element: <Navigate to="overview" replace /> },
                  // G — overview
                  {
                    path: "overview",
                    lazy: () =>
                      import("@/features/overview/overview-page").then((m) => ({
                        Component: m.OverviewPage,
                      })),
                  },
                  // Q — workspace settings
                  {
                    path: "settings",
                    lazy: () =>
                      import("@/features/workspaces/settings/settings-page").then((m) => ({
                        Component: m.SettingsPage,
                      })),
                    children: [
                      { index: true, element: <Navigate to="general" replace /> },
                      {
                        path: "general",
                        lazy: () =>
                          import("@/features/workspaces/settings/general-tab").then((m) => ({
                            Component: m.GeneralTab,
                          })),
                      },
                      {
                        path: "members",
                        lazy: () =>
                          import("@/features/workspaces/settings/members-tab").then((m) => ({
                            Component: m.MembersTab,
                          })),
                      },
                      {
                        path: "api-keys",
                        lazy: () =>
                          import("@/features/workspaces/settings/api-keys-tab").then((m) => ({
                            Component: m.ApiKeysTab,
                          })),
                      },
                      {
                        path: "audit",
                        lazy: () =>
                          import("@/features/workspaces/settings/audit-tab").then((m) => ({
                            Component: m.AuditTab,
                          })),
                      },
                    ],
                  },
                  // H, I, J — agents
                  {
                    path: "agents",
                    lazy: () =>
                      import("@/features/agents/agents-page").then((m) => ({
                        Component: m.AgentsPage,
                      })),
                  },
                  {
                    path: "agents/new",
                    lazy: () =>
                      import("@/features/agents/agent-editor-page").then((m) => ({
                        Component: m.AgentEditorPage,
                      })),
                  },
                  {
                    path: "agents/:agentId",
                    lazy: () =>
                      import("@/features/agents/agent-page").then((m) => ({
                        Component: m.AgentPage,
                      })),
                  },
                  {
                    path: "agents/:agentId/edit",
                    lazy: () =>
                      import("@/features/agents/agent-editor-page").then((m) => ({
                        Component: m.AgentEditorPage,
                      })),
                  },
                  // L, M — executions
                  {
                    path: "executions",
                    lazy: () =>
                      import("@/features/executions/executions-page").then((m) => ({
                        Component: m.ExecutionsPage,
                      })),
                  },
                  {
                    path: "executions/:executionId",
                    lazy: () =>
                      import("@/features/executions/execution-page").then((m) => ({
                        Component: m.ExecutionPage,
                      })),
                  },
                  // P — usage
                  {
                    path: "usage",
                    lazy: () =>
                      import("@/features/usage/usage-page").then((m) => ({
                        Component: m.UsagePage,
                      })),
                  },
                  // S — evaluations
                  {
                    path: "evaluations",
                    lazy: () =>
                      import("@/features/evaluations/evaluations-page").then((m) => ({
                        Component: m.EvaluationsPage,
                      })),
                  },
                  {
                    path: "evaluations/suites/:suiteId",
                    lazy: () =>
                      import("@/features/evaluations/suite-page").then((m) => ({
                        Component: m.SuitePage,
                      })),
                  },
                  {
                    path: "evaluations/runs/:runId",
                    lazy: () =>
                      import("@/features/evaluations/run-page").then((m) => ({
                        Component: m.RunPage,
                      })),
                  },
                  {
                    path: "evaluations/compare",
                    lazy: () =>
                      import("@/features/evaluations/compare-page").then((m) => ({
                        Component: m.ComparePage,
                      })),
                  },
                  // T — workflows
                  {
                    path: "workflows",
                    lazy: () =>
                      import("@/features/workflows/workflows-page").then((m) => ({
                        Component: m.WorkflowsPage,
                      })),
                  },
                  {
                    path: "workflows/runs/:runId",
                    lazy: () =>
                      import("@/features/workflows/run-page").then((m) => ({
                        Component: m.WorkflowRunPage,
                      })),
                  },
                  {
                    path: "workflows/:workflowId",
                    lazy: () =>
                      import("@/features/workflows/workflow-page").then((m) => ({
                        Component: m.WorkflowPage,
                      })),
                  },
                  // O — providers
                  {
                    path: "providers",
                    lazy: () =>
                      import("@/features/providers/providers-page").then((m) => ({
                        Component: m.ProvidersPage,
                      })),
                  },
                  // N — tools
                  {
                    path: "tools",
                    lazy: () =>
                      import("@/features/tools/tools-page").then((m) => ({
                        Component: m.ToolsPage,
                      })),
                  },
                  {
                    path: "tools/:toolId",
                    lazy: () =>
                      import("@/features/tools/tool-page").then((m) => ({ Component: m.ToolPage })),
                  },
                  // H–P, S, T — sections delivered in later phases (honest interim pages)
                  {
                    path: ":section/*",
                    lazy: () =>
                      import("@/features/interim/interim-page").then((m) => ({
                        Component: m.InterimPage,
                      })),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: "*",
        lazy: () => import("./not-found-page").then((m) => ({ Component: m.NotFoundPage })),
      },
    ],
  },
]);
