"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LayoutGrid, ChevronRight, ExternalLink } from "lucide-react";

interface AppEntry {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
  status: string | null;
  version: string | null;
}

export function AppsListClient({ isAdmin }: { isAdmin: boolean }) {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const t = useTranslations("appsSettings");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/v1/apps/drawer");
        if (res.ok) {
          const data = await res.json();
          setApps(data.apps ?? []);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading apps...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <LayoutGrid className="h-5 w-5" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("description")}
        </p>
      </div>

      {apps.length === 0 ? (
        <div className="border rounded-lg p-8 text-center text-sm text-muted-foreground">
          No apps installed yet.
        </div>
      ) : (
        <div className="border rounded-lg divide-y">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => router.push(`/settings/apps/${app.id}`)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-primary">
                  {app.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{app.name}</span>
                  {app.status && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      app.status === "healthy"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                    }`}>
                      {app.status}
                    </span>
                  )}
                </div>
                {app.subdomain && (
                  <p className="text-xs text-muted-foreground font-mono">{app.subdomain}</p>
                )}
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
