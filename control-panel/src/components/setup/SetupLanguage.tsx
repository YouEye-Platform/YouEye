'use client';
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface LanguageOption {
  code: string;
  native: string;
  flag: string;
}

const LANGUAGES: LanguageOption[] = [
  { code: 'en', native: 'English', flag: '🇬🇧' },
  { code: 'ru', native: 'Русский', flag: '🇷🇺' },
  { code: 'es', native: 'Español', flag: '🇪🇸' },
  { code: 'de', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', native: 'Français', flag: '🇫🇷' },
];

interface Props {
  onSelect: (code: string) => void;
}

export default function SetupLanguage({ onSelect }: Props) {
  const translateInterface = useInterfaceTranslations("interface");

  const [selecting, setSelecting] = useState<string | null>(null);

  const handleSelect = (code: string) => {
    setSelecting(code);
    onSelect(code);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="text-center mb-10 animate-in fade-in slide-in-from-bottom-4 duration-500 motion-reduce:animate-none">
        <h1 className="text-3xl font-bold mb-3">{translateInterface("m8e2d0664dbbb")}</h1>
        <p className="text-muted-foreground text-sm">
          Выберите язык &middot; Wählen Sie Ihre Sprache &middot; Elige tu idioma &middot; Choisissez votre langue
        </p>
      </div>

      <div className="space-y-2.5 animate-in fade-in slide-in-from-bottom-6 duration-500 motion-reduce:animate-none delay-100">
        {LANGUAGES.map((lang, i) => (
          <button
            key={lang.code}
            onClick={() => handleSelect(lang.code)}
            disabled={selecting !== null}
            className="w-full flex items-center gap-4 px-6 py-4 rounded-xl border border-border/60 bg-card backdrop-blur-sm hover:border-primary/40 hover:bg-primary/5 hover:shadow-md transition-all duration-200 text-left group disabled:opacity-60"
            style={{ animationDelay: `${150 + i * 50}ms` }}
          >
            <span className="text-3xl">{lang.flag}</span>
            <span className="text-base font-medium group-hover:text-primary transition-colors">
              {lang.native}
            </span>
            {selecting === lang.code && (
              <Loader2 className="h-4 w-4 animate-spin text-primary ml-auto" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
