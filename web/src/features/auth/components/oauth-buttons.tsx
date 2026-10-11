import { useTranslation } from "react-i18next";
import { useMeta } from "@/lib/auth/session";
import { GitHubIcon, GoogleIcon } from "@/components/brand/brand-icons";
import { Button } from "@/components/ui/button";
import { Divider } from "./auth-ui";

const PROVIDERS = {
  github: { Icon: GitHubIcon, label: "oauth.github" },
  google: { Icon: GoogleIcon, label: "oauth.google" },
} as const;

type Provider = keyof typeof PROVIDERS;
const isProvider = (value: string): value is Provider => value in PROVIDERS;

/**
 * "Continue with GitHub / Google": plain links to the API, which redirects to the provider.
 * A provider appears only when this instance enables it (no button, no error otherwise).
 */
export function OAuthButtons({ next }: { next: string | null }) {
  const { t } = useTranslation("auth");
  const meta = useMeta();
  if (meta.isPending) return <div aria-hidden className="h-[122px]" />;
  const providers = (meta.data?.oauth_providers ?? []).filter(isProvider);
  if (providers.length === 0) return null;
  const query = next ? `?next=${encodeURIComponent(next)}` : "";
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-2.5">
        {providers.map((provider) => {
          const { Icon, label } = PROVIDERS[provider];
          return (
            <Button
              key={provider}
              asChild
              variant="secondary"
              size="lg"
              className="w-full"
              leftIcon={<Icon className="size-4.5" />}
            >
              <a href={`/api/v1/auth/oauth/${provider}/start${query}`}>{t(label)}</a>
            </Button>
          );
        })}
      </div>
      <Divider label={t("oauth.divider")} />
    </div>
  );
}
