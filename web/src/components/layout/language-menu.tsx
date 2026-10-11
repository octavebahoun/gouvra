import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { currentLanguage } from "@/lib/i18n";
import { languageNames, supportedLanguages } from "@/lib/i18n/resources";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";

/** Compact language switch for pages outside the app shell (sign-in, onboarding). */
export function LanguageMenu({ className }: { className?: string }) {
  const { t, i18n } = useTranslation("shell");
  const language = currentLanguage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("language.current", { language: languageNames[language] })}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-field px-2.5 text-[13px] font-medium text-muted transition-colors max-md:h-10",
          "hover:bg-surface-2 hover:text-ink data-[state=open]:bg-surface-2 data-[state=open]:text-ink",
          className,
        )}
      >
        <Languages aria-hidden className="size-4" />
        <span className="uppercase">{language}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={language}
          onValueChange={(value) => void i18n.changeLanguage(value)}
        >
          {supportedLanguages.map((lng) => (
            <DropdownMenuRadioItem key={lng} value={lng} lang={lng}>
              {languageNames[lng]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
