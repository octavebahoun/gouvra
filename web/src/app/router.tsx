import { createBrowserRouter } from "react-router";
import { RouteError } from "./route-error";

/**
 * Routes are lazy-loaded per feature (one chunk each). Every screen of the UI inventory
 * (A–T) has a route here; permissions are enforced by the API and reflected by the UI.
 */
export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
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
      {
        path: "*",
        lazy: () => import("./not-found-page").then((m) => ({ Component: m.NotFoundPage })),
      },
    ],
  },
]);
