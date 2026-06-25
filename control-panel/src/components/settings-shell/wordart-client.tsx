"use client";

import { useEffect, useState } from "react";
import { uiSettingsApi } from "./api-base";

export function WordArtClient() {
  const [json, setJson] = useState("{}");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch(uiSettingsApi("wordart"))
      .then((r) => r.json())
      .then((data) => setJson(JSON.stringify(data.wordart ?? {}, null, 2)))
      .catch(() => setStatus("Could not load WordArt."));
  }, []);

  async function save() {
    try {
      const wordart = JSON.parse(json);
      const res = await fetch(uiSettingsApi("wordart"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordart }),
      });
      setStatus(res.ok ? "Saved" : "Save failed");
    } catch {
      setStatus("Invalid JSON");
    }
  }

  async function reset() {
    const res = await fetch(uiSettingsApi("wordart"), { method: "DELETE" });
    if (res.ok) setJson("{}");
    setStatus(res.ok ? "Reset" : "Reset failed");
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-base font-medium">Personal WordArt</h2>
        <p className="text-sm text-muted-foreground">Stored in the UI profile settings.</p>
      </div>
      <textarea value={json} onChange={(event) => setJson(event.target.value)} className="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-xs" />
      <div className="flex gap-2">
        <button onClick={save} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">Save</button>
        <button onClick={reset} className="rounded-md border px-3 py-2 text-sm">Reset</button>
      </div>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </section>
  );
}
