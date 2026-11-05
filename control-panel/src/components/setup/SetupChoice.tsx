'use client';
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { Sparkles, ArchiveRestore } from 'lucide-react';

interface Props {
  onNewSetup: () => void;
  onRestore: () => void;
}

export default function SetupChoice({ onNewSetup, onRestore }: Props) {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-3xl font-bold mb-3">{translateInterface("m03d18c3e86dc")}</h1>
        <p className="text-muted-foreground text-sm">
          {translateInterface("m6bcfdf4dddf5")}</p>
      </div>

      <div className="grid gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500 delay-100">
        <button
          onClick={onNewSetup}
          className="flex items-start gap-5 px-6 py-5 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-accent/50 transition-colors text-left group"
        >
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 shrink-0 group-hover:bg-primary/20 transition-colors">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
              {translateInterface("mf11b2b8dd77a")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {translateInterface("m14eb93aa8d42")}</p>
          </div>
        </button>

        <button
          onClick={onRestore}
          className="flex items-start gap-5 px-6 py-5 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-accent/50 transition-colors text-left group"
        >
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-orange-500/10 shrink-0 group-hover:bg-orange-500/20 transition-colors">
            <ArchiveRestore className="h-6 w-6 text-orange-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
              {translateInterface("mb8903550fe8a")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {translateInterface("m1b76c255e832")}</p>
          </div>
        </button>
      </div>
    </div>
  );
}
