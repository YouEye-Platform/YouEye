"use client";

import { useEffect, useState, useCallback } from "react";

const LANGUAGES = [
  { code: "en", native: "English", english: "English" },
  { code: "ru", native: "Русский", english: "Russian" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "fr", native: "Français", english: "French" },
];

export function LanguageEmbedClient() {
  const [currentLang, setCurrentLang] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const fetchLanguage = useCallback(async () => {
    try {
      const res = await fetch("/api/ui-bridge/language");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCurrentLang(data.language || "en");
    } catch {
      setCurrentLang("en");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLanguage(); }, [fetchLanguage]);

  const handleChange = async (code: string) => {
    setSaving(true);
    setStatus("idle");
    try {
      const configRes = await fetch("/api/ui-bridge/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      if (!configRes.ok) { setStatus("error"); return; }

      setCurrentLang(code);
      setStatus("saved");

      fetch("/api/ui-bridge/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: code }),
      }).catch(() => {});

      setTimeout(() => setStatus("idle"), 3000);
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 16, width: 180, marginBottom: 12 }} />
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="embed-skeleton" style={{ height: 44, width: "100%", marginBottom: 8, borderRadius: 8 }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div className="embed-title" style={{ fontSize: 14 }}>System Default Language</div>
        <div className="embed-subtitle">
          Sets the default language for all users who haven&apos;t chosen their own. Also propagates to Authentik and app containers.
        </div>
      </div>

      <div style={{ maxWidth: 400 }}>
        {LANGUAGES.map(lang => {
          const isSelected = currentLang === lang.code;
          return (
            <button
              key={lang.code}
              onClick={() => handleChange(lang.code)}
              disabled={saving}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "10px 14px", borderRadius: 8, marginBottom: 6,
                border: `1px solid ${isSelected ? "var(--embed-primary)" : "var(--embed-border)"}`,
                background: isSelected ? "color-mix(in srgb, var(--embed-primary) 8%, transparent)" : "transparent",
                color: "var(--embed-text)", cursor: saving ? "not-allowed" : "pointer",
                fontSize: 13, textAlign: "left", opacity: saving ? 0.6 : 1,
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              <span>
                <span style={{ fontWeight: 500 }}>{lang.native}</span>
                {lang.native !== lang.english && (
                  <span className="embed-muted" style={{ marginLeft: 8 }}>({lang.english})</span>
                )}
              </span>
              {isSelected && <span style={{ color: "var(--embed-primary)", fontWeight: 600 }}>✓</span>}
            </button>
          );
        })}
      </div>

      {status === "saved" && (
        <div style={{ marginTop: 8, fontSize: 13, color: "var(--embed-success)" }}>
          System language updated. Propagating to apps...
        </div>
      )}
      {status === "error" && (
        <div style={{ marginTop: 8, fontSize: 13, color: "var(--embed-danger)" }}>
          Failed to update system language.
        </div>
      )}
    </div>
  );
}
