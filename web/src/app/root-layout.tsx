import { Outlet, ScrollRestoration } from "react-router";
import { PreferencesSync, SessionWatcher } from "@/lib/auth/session-sync";
import { RouteFocus } from "./route-focus";

/** Wraps every route: session watchers, preference sync, focus and scroll management. */
export function RootLayout() {
  return (
    <>
      <SessionWatcher />
      <PreferencesSync />
      <RouteFocus />
      <ScrollRestoration />
      <Outlet />
    </>
  );
}
