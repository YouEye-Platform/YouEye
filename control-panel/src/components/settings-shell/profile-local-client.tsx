"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { uiSettingsApi } from "./api-base";

interface ProfileData {
  bio: string | null;
  timezone: string | null;
}

export function ProfileLocalClient() {
  const [profile, setProfile] = useState<ProfileData>({ bio: "", timezone: "" });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch(uiSettingsApi("profile"))
      .then((r) => r.json())
      .then((data) => setProfile({
        bio: data.bio || "",
        timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
      .catch(() => setStatus("Could not load local profile fields."));
  }, []);

  async function save() {
    setSaving(true);
    setStatus("");
    const res = await fetch(uiSettingsApi("profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
  }

  return (
    <section className="max-w-lg space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-base font-medium">Local Profile</h2>
        <p className="text-sm text-muted-foreground">Bio and timezone are stored in the YouEye UI profile.</p>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Bio</span>
        <textarea
          value={profile.bio || ""}
          onChange={(event) => setProfile((current) => ({ ...current, bio: event.target.value }))}
          className="min-h-24 w-full rounded-md border bg-background px-3 py-2"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Timezone</span>
        <input
          value={profile.timezone || ""}
          onChange={(event) => setProfile((current) => ({ ...current, timezone: event.target.value }))}
          className="w-full rounded-md border bg-background px-3 py-2"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save"}
        </button>
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </section>
  );
}
