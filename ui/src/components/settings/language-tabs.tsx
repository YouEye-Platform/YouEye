"use client";

import { useState } from "react";
import { UserLanguageSettings } from "./user-language-settings";
import { AdminEmbed } from "./admin-embed";

interface LanguageTabsProps {
  currentLanguage: string | null;
  isAdmin: boolean;
  serverLanguageUrl: string | null;
}

export function LanguageTabs({ currentLanguage, isAdmin, serverLanguageUrl }: LanguageTabsProps) {
  const [tab, setTab] = useState<"my-language" | "server-language">("my-language");

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setTab("my-language")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "my-language"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          My Language
        </button>
        {isAdmin && serverLanguageUrl && (
          <button
            onClick={() => setTab("server-language")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "server-language"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Server Language
          </button>
        )}
      </div>

      {tab === "my-language" && (
        <UserLanguageSettings currentLanguage={currentLanguage} />
      )}

      {tab === "server-language" && isAdmin && serverLanguageUrl && (
        <AdminEmbed signedUrl={serverLanguageUrl} title="System Language" minHeight={300} />
      )}
    </div>
  );
}
