'use client';

import { Sparkles, ArchiveRestore } from 'lucide-react';

interface Props {
  onNewSetup: () => void;
  onRestore: () => void;
}

export default function SetupChoice({ onNewSetup, onRestore }: Props) {
  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-3xl font-bold mb-3">Welcome to YouEye</h1>
        <p className="text-muted-foreground text-sm">
          How would you like to get started?
        </p>
      </div>

      <div className="grid gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500 delay-100">
        <button
          onClick={onNewSetup}
          className="flex items-start gap-5 px-6 py-5 rounded-xl border border-border/60 bg-white/80 backdrop-blur-sm hover:border-primary/40 hover:bg-primary/5 hover:shadow-md transition-all duration-200 text-left group"
        >
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 shrink-0 group-hover:bg-primary/20 transition-colors">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
              Set up a new YouEye
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Configure your server name, admin account, and start fresh.
            </p>
          </div>
        </button>

        <button
          onClick={onRestore}
          className="flex items-start gap-5 px-6 py-5 rounded-xl border border-border/60 bg-white/80 backdrop-blur-sm hover:border-primary/40 hover:bg-primary/5 hover:shadow-md transition-all duration-200 text-left group"
        >
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-orange-500/10 shrink-0 group-hover:bg-orange-500/20 transition-colors">
            <ArchiveRestore className="h-6 w-6 text-orange-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
              Restore from backup
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Restore your platform from a previous backup archive, including all apps and settings.
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
