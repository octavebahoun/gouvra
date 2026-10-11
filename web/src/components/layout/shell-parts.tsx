import {
  Check,
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Shield,
  Sun,
  UserRound,
  WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSyncExternalStore, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { getReachability, subscribeReachability } from "@/lib/api/http";
import { languageNames, supportedLanguages, type Language } from "@/lib/i18n/resources";
import { currentLanguage } from "@/lib/i18n";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { spring } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import type { Role } from "@/lib/auth/types";

/** One-click light/dark switch with a morphing icon and a circular reveal of the new theme. */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setThemePreference(next, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("theme.toggle", { mode: t(`theme.${next}`).toLowerCase() })}
      title={t("theme.toggle", { mode: t(`theme.${next}`).toLowerCase() })}
      className={cn(
        "relative inline-flex size-9 items-center justify-center overflow-hidden rounded-field text-muted transition-colors hover:bg-surface-2 hover:text-ink max-md:size-10",
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={resolved}
          initial={{ y: 14, rotate: -90, opacity: 0 }}
          animate={{ y: 0, rotate: 0, opacity: 1, transition: spring.snappy }}
          exit={{ y: -14, rotate: 90, opacity: 0, transition: { duration: 0.12 } }}
          className="inline-flex"
        >
          {resolved === "dark" ? (
            <Moon aria-hidden className="size-4" />
          ) : (
            <Sun aria-hidden className="size-4" />
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

type UserMenuProps = {
  user: { display_name: string; email: string; is_superadmin: boolean };
  onSignOut: () => void;
  onLanguageChange?: (language: Language) => void;
  onThemeChange?: (theme: ThemePreference) => void;
  collapsed?: boolean;
  /** Instance administration page, shown to super-admins once it exists. */
  adminHref?: string;
  /** Where the menu opens: above the trigger (sidebar footer) or below it (top bars). */
  placement?: "top" | "bottom";
  className?: string;
};

export function UserMenu({
  user,
  onSignOut,
  onLanguageChange,
  onThemeChange,
  collapsed = false,
  adminHref,
  placement = "top",
  className,
}: UserMenuProps) {
  const { t, i18n } = useTranslation();
  const { preference } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("userMenu.label")}
        className={cn(
          "flex h-11 w-full items-center gap-2.5 rounded-field px-2 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2",
          collapsed && "justify-center px-0",
          className,
        )}
      >
        <Avatar name={user.display_name} size="sm" />
        {!collapsed ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">
              {user.display_name}
            </span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={placement}
        align={placement === "top" ? "start" : "end"}
        className="w-64"
      >
        {collapsed ? (
          <>
            <div className="px-2.5 pt-2 pb-1.5">
              <p className="truncate text-[13px] font-medium text-ink">{user.display_name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserRound aria-hidden />
            {t("userMenu.profile")}
          </Link>
        </DropdownMenuItem>
        {user.is_superadmin && adminHref ? (
          <DropdownMenuItem asChild>
            <Link to={adminHref}>
              <Shield aria-hidden />
              {t("userMenu.admin")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            const theme = value as ThemePreference;
            setThemePreference(theme);
            onThemeChange?.(theme);
          }}
        >
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden />
            {t("theme.light")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden />
            {t("theme.dark")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden />
            {t("theme.system")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={currentLanguage()}
          onValueChange={(value) => {
            void i18n.changeLanguage(value);
            onLanguageChange?.(value as Language);
          }}
        >
          {supportedLanguages.map((lng) => (
            <DropdownMenuRadioItem key={lng} value={lng} lang={lng}>
              <Languages aria-hidden />
              {languageNames[lng]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut aria-hidden />
          {t("actions.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type WorkspaceOption = { id: string; name: string; slug: string; role: Role };

type WorkspaceSwitcherProps = {
  current: WorkspaceOption;
  workspaces: WorkspaceOption[];
  onSelect: (workspace: WorkspaceOption) => void;
  onCreate: () => void;
  collapsed?: boolean;
};

export function WorkspaceSwitcher({
  current,
  workspaces,
  onSelect,
  onCreate,
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${t("workspace.switcherLabel")}: ${current.name}`}
        className={cn(
          "flex h-12 w-full items-center gap-2.5 rounded-card border border-line bg-surface px-2.5 text-left shadow-sm transition-colors",
          "hover:border-line-strong/60 data-[state=open]:border-brand",
          collapsed && "h-10 justify-center border-transparent px-0 shadow-none",
        )}
      >
        <Avatar name={current.name} square size="sm" />
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-ink">
                {current.name}
              </span>
              <span className="block truncate text-xs text-muted">
                {t(`workspace.role.${current.role}`)}
              </span>
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t("workspace.switchTo")}</DropdownMenuLabel>
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => onSelect(workspace)}
            className="h-10"
          >
            <Avatar name={workspace.name} square size="xs" />
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            {workspace.id === current.id ? (
              <Check aria-hidden className="text-brand-text!" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreate}>
          <Plus aria-hidden />
          {t("workspace.create")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener("online", callback);
      window.addEventListener("offline", callback);
      return () => {
        window.removeEventListener("online", callback);
        window.removeEventListener("offline", callback);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** Offline / API-unreachable banner. Unsent form input is never discarded. */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  const reachability = useSyncExternalStore(
    subscribeReachability,
    getReachability,
    () => "ok" as const,
  );
  const problem = !online ? "offline" : reachability === "down" ? "api" : null;
  return (
    <AnimatePresence>
      {problem ? (
        <motion.div
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden border-b border-warning/40 bg-warning-soft"
        >
          <div className="flex items-center gap-2 px-4 py-2 text-[13px] text-warning-text">
            <WifiOff aria-hidden className="size-4 shrink-0" />
            <span className="font-medium">
              {problem === "offline" ? t("states.offlineTitle") : t("states.apiDownTitle")}
            </span>
            <span className="hidden text-ink/80 sm:inline">
              {problem === "offline" ? t("states.offlineBody") : t("states.apiDownBody")}
            </span>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
