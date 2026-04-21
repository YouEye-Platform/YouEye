"use client";

/**
 * Profile Embed Client
 *
 * Lets users edit their own first name and last name.
 * Changes are saved to Authentik via /api/user/profile (CP backend).
 * This is embedded in YE-UI settings as an iframe.
 */

import { useEffect, useState, useCallback } from "react";

interface ProfileEmbedClientProps {
  username: string;
  isAdmin: boolean;
}

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
}

export function ProfileEmbedClient({ username, isAdmin }: ProfileEmbedClientProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/user/profile");
      if (!res.ok) throw new Error("Failed to load profile");
      const data = await res.json();
      setProfile(data);
      setFirstName(data.firstName || "");
      setLastName(data.lastName || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Report height to parent for auto-sizing
  useEffect(() => {
    const report = () => {
      const h = document.body.scrollHeight;
      window.parent.postMessage({ type: "youeye-embed-resize", height: h }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    window.parent.postMessage({ type: "youeye-embed-ready" }, "*");
    return () => observer.disconnect();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);

    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }

      const updated = await res.json();
      setProfile(updated);
      setSaved(true);

      // Notify the parent UI so it can update the displayed name
      window.parent.postMessage({
        type: "youeye-profile-updated",
        firstName: updated.firstName,
        lastName: updated.lastName,
      }, "*");

      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = profile && (firstName.trim() !== (profile.firstName || "") || lastName.trim() !== (profile.lastName || ""));

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-card">
          <div style={{ display: "flex", gap: 12 }}>
            <div className="embed-skeleton" style={{ width: "50%", height: 36 }} />
            <div className="embed-skeleton" style={{ width: "50%", height: 36 }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-card">
        <div className="embed-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="8" r="4" />
            <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
          </svg>
          Account Name
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>First Name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              style={{
                width: "100%",
                padding: "8px 12px",
                background: "var(--embed-bg, transparent)",
                border: "1px solid var(--embed-border)",
                borderRadius: 6,
                color: "var(--embed-text)",
                fontSize: 14,
                outline: "none",
              }}
            />
          </div>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Last Name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              style={{
                width: "100%",
                padding: "8px 12px",
                background: "var(--embed-bg, transparent)",
                border: "1px solid var(--embed-border)",
                borderRadius: 6,
                color: "var(--embed-text)",
                fontSize: 14,
                outline: "none",
              }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Username</label>
            <div className="embed-muted" style={{ padding: "8px 12px", fontSize: 14, border: "1px solid var(--embed-border)", borderRadius: 6, opacity: 0.7 }}>
              {username}
            </div>
          </div>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Email</label>
            <div className="embed-muted" style={{ padding: "8px 12px", fontSize: 14, border: "1px solid var(--embed-border)", borderRadius: 6, opacity: 0.7 }}>
              {profile?.email || "—"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="embed-btn"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            style={{
              background: hasChanges ? "var(--embed-primary)" : "var(--embed-card-bg)",
              color: hasChanges ? "white" : "var(--embed-text)",
              opacity: saving || !hasChanges ? 0.5 : 1,
            }}
          >
            {saving ? (
              <>
                <span style={{ width: 14, height: 14, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.6s linear infinite", display: "inline-block" }} />
                Saving...
              </>
            ) : "Save Name"}
          </button>
          {saved && <span style={{ fontSize: 13, color: "var(--embed-success)" }}>Saved to account</span>}
          {error && <span style={{ fontSize: 13, color: "var(--embed-danger)" }}>{error}</span>}
        </div>

        {isAdmin && (
          <div style={{ marginTop: 12, padding: "6px 10px", borderRadius: 6, fontSize: 12, color: "var(--embed-primary)", border: "1px solid color-mix(in srgb, var(--embed-primary) 30%, transparent)" }}>
            ✦ Administrator
          </div>
        )}
      </div>

      <style>{`
        @keyframes embed-spin {
          to { transform: rotate(360deg); }
        }
        input:focus {
          border-color: var(--embed-primary) !important;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--embed-primary) 20%, transparent);
        }
      `}</style>
    </div>
  );
}
