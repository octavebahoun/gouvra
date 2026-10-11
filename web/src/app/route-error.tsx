import { isRouteErrorResponse, useRouteError } from "react-router";
import { ErrorState, NotFoundState } from "@/components/ui/states";

export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundState className="min-h-dvh" />;
  }
  return (
    <ErrorState error={error} className="min-h-dvh" onRetry={() => window.location.reload()} />
  );
}
