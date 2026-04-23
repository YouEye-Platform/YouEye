"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LayoutGrid,
  RefreshCw,
  Check,
  Trash2,
  Star,
  Globe,
  Server,
} from "lucide-react";

interface ConnectorOption {
  id: string;
  name: string;
  network: string;
}

interface DefaultEntry {
  capability: string;
  connectorId: string;
  hasSharedKey: boolean;
  setAt: string | null;
}

export function ConnectorDefaultsAdmin() {
  const [defaults, setDefaults] = useState<DefaultEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ConnectorOption[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const fetchDefaults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/admin/connector-defaults");
      if (res.ok) {
        const data = await res.json();
        setDefaults(data.defaults ?? []);
        setCapabilities(data.capabilities ?? {});
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDefaults();
  }, [fetchDefaults]);

  const setDefault = async (capability: string, connectorId: string) => {
    setSaving(capability);
    try {
      await fetch("/api/settings/admin/connector-defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, connectorId }),
      });
      fetchDefaults();
    } finally {
      setSaving(null);
    }
  };

  const removeDefault = async (capability: string) => {
    setSaving(capability);
    try {
      await fetch("/api/settings/admin/connector-defaults", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability }),
      });
      fetchDefaults();
    } finally {
      setSaving(null);
    }
  };

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const defaultMap = new Map(defaults.map((d) => [d.capability, d]));

  // Sort capabilities: ones with defaults first, then alphabetical
  const allCapabilities = Object.keys(capabilities).sort((a, b) => {
    const aHas = defaultMap.has(a) ? 0 : 1;
    const bHas = defaultMap.has(b) ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium flex items-center gap-2">
            <LayoutGrid className="w-4 h-4" />
            Connector Defaults
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Set system-wide default connectors for each capability. New users will start with these pre-selected.
          </p>
        </div>
        <button
          onClick={fetchDefaults}
          disabled={loading}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
      ) : allCapabilities.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg">
          No connectors available in the catalog.
        </div>
      ) : (
        <div className="border rounded-lg divide-y">
          {allCapabilities.map((cap) => {
            const current = defaultMap.get(cap);
            const connectors = capabilities[cap] ?? [];
            const currentConnector = current
              ? connectors.find((c) => c.id === current.connectorId)
              : null;

            return (
              <div key={cap} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{formatCapability(cap)}</div>
                  {current && currentConnector && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Star className="w-3 h-3 text-amber-500" />
                      {currentConnector.name}
                      {currentConnector.network === "local" ? (
                        <Server className="w-3 h-3 text-green-500 ml-1" />
                      ) : (
                        <Globe className="w-3 h-3 text-blue-500 ml-1" />
                      )}
                    </div>
                  )}
                  {!current && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      No default set — users choose their own
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={current?.connectorId ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val) setDefault(cap, val);
                    }}
                    disabled={saving === cap}
                    className="text-sm border rounded-md px-2 py-1 bg-background min-w-[160px]"
                  >
                    <option value="">— None —</option>
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.network === "local" ? "Local" : "Internet"})
                      </option>
                    ))}
                  </select>

                  {current && (
                    <button
                      onClick={() => removeDefault(cap)}
                      disabled={saving === cap}
                      className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      title="Remove default"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {saving === cap && (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Defaults are applied when new users first visit an app that uses connectors. Existing users keep their own choices.
      </p>
    </div>
  );
}
