"use client";

import { useEffect, useState } from "react";
import { uiSettingsApi } from "./api-base";

interface Theme {
  id: string;
  name: string;
  colors?: Record<string, string>;
}

export function AppearanceClient() {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState("system");
  const [status, setStatus] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(uiSettingsApi("themes")).then((r) => r.json()),
      fetch(uiSettingsApi("themes/active")).then((r) => r.json()),
    ])
      .then(([allThemes, active]) => {
        setThemes(Array.isArray(allThemes) ? allThemes : []);
        setActiveId(active.id || null);
        setMode(active.mode || "system");
      })
      .catch(() => setStatus("Could not load themes."));
  }, []);

  async function selectTheme(themeId: string) {
    setActiveId(themeId);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId }),
    });
    setStatus(res.ok ? "Theme saved" : "Theme save failed");
  }

  async function selectMode(nextMode: string) {
    setMode(nextMode);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    });
    setStatus(res.ok ? "Mode saved" : "Mode save failed");
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-medium">Mode</h2>
        <div className="inline-flex overflow-hidden rounded-md border">
          {["system", "light", "dark"].map((item) => (
            <button
              key={item}
              onClick={() => selectMode(item)}
              className={`px-4 py-2 text-sm capitalize ${mode === item ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-medium">Themes</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {themes.map((theme) => (
            <button
              key={theme.id}
              onClick={() => selectTheme(theme.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${activeId === theme.id ? "border-primary bg-primary/5" : "hover:bg-accent/50"}`}
            >
              <div className="font-medium">{theme.name}</div>
              <div className="mt-3 flex gap-1">
                {Object.values(theme.colors || {}).slice(0, 5).map((color, index) => (
                  <span key={`${theme.id}-${index}`} className="h-5 w-5 rounded-full border" style={{ backgroundColor: color }} />
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
