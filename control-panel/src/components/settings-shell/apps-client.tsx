"use client";

import { useEffect, useState } from "react";
import { uiSettingsApi } from "./api-base";

interface DrawerApp {
  id: string;
  name: string;
  icon: string | null;
  visible: boolean;
  status: string | null;
}

export function AppsClient() {
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [status, setStatus] = useState("");

  async function load() {
    const res = await fetch(uiSettingsApi("apps/drawer"));
    if (!res.ok) {
      setStatus("Could not load apps.");
      return;
    }
    const data = await res.json();
    setApps(data.apps || []);
  }

  useEffect(() => { load(); }, []);

  async function toggle(app: DrawerApp) {
    setApps((current) => current.map((item) => item.id === app.id ? { ...item, visible: !item.visible } : item));
    const res = await fetch(uiSettingsApi(`apps/drawer/${encodeURIComponent(app.id)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: !app.visible }),
    });
    setStatus(res.ok ? "Saved" : "Save failed");
    if (!res.ok) load();
  }

  return (
    <div className="space-y-4">
      {apps.map((app) => (
        <div key={app.id} className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
          <div>
            <div className="font-medium">{app.name}</div>
            <div className="text-xs text-muted-foreground">{app.status || "unknown"}</div>
          </div>
          <button
            onClick={() => toggle(app)}
            className={`rounded-md px-3 py-1.5 text-sm ${app.visible ? "bg-primary text-primary-foreground" : "border"}`}
          >
            {app.visible ? "Visible" : "Hidden"}
          </button>
        </div>
      ))}
      {apps.length === 0 && <div className="rounded-lg border p-6 text-sm text-muted-foreground">No apps installed yet.</div>}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
