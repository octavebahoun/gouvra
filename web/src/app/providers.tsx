import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { useTheme } from "@/lib/theme";
import { LiveRegionProvider } from "@/components/ui/live-region";
import { TooltipProvider } from "@/components/ui/menu";
import { createQueryClient } from "./query-client";

function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-card !border-line !bg-surface !text-ink !shadow-lg !font-sans",
          description: "!text-muted",
        },
      }}
    />
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {/* reducedMotion="user": every Motion animation honours prefers-reduced-motion */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          <LiveRegionProvider>
            {children}
            <ThemedToaster />
          </LiveRegionProvider>
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
