"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatVersion } from "@/lib/version";

// ─── Types (mirror GET /api/updates/channels) ──────────────────────────────

interface VersionRef {
  version: string | null;
  branch: string | null;
  tag: string | null;
}

interface ChannelOverride {
  source?: string;
  branch?: string;
  tag?: string;
  artifact_sha256?: string;
  fallback?: string[];
}

interface EffectiveChannel {
  source: string;
  branch: string;
  fallback: string[];
  tag?: string;
  artifact_sha256?: string;
}

interface ComponentEntry {
  channel: EffectiveChannel;
  override: ChannelOverride | null;
  installed: VersionRef;
  candidate: VersionRef;
  update_available: boolean;
  switch_pending: boolean;
  installed_display?: string | null;
  candidate_display?: string | null;
}

type ChannelsResponse = { components: Record<string, ComponentEntry> };

// Human names per copy rules — core services get product names, never component names.
const COMPONENT_LABELS: Record<string, string> = {
  default: "Default (all components)",
  spine: "System core",
  control: "Server interface",
  ui: "Dashboard",
};

function labelFor(id: string): string {
  if (COMPONENT_LABELS[id]) return COMPONENT_LABELS[id];
  if (id.startsWith("app:")) return id.slice("app:".length);
  return id;
}

// Fixed display order for core components; apps follow, alphabetically.
const CORE_ORDER = ["default", "spine", "control", "ui"];

function orderComponents(ids: string[]): string[] {
  const core = CORE_ORDER.filter((c) => ids.includes(c));
  const apps = ids.filter((id) => id.startsWith("app:")).sort();
  const rest = ids.filter((id) => !CORE_ORDER.includes(id) && !id.startsWith("app:")).sort();
  return [...core, ...apps, ...rest];
}

// ─── Fallback editor mode ──────────────────────────────────────────────────

type FallbackMode = "default" | "custom" | "disabled";

/** Derive the initial fallback editor mode from an override (pitfall #21: no flash). */
function deriveFallbackMode(override: ChannelOverride | null): FallbackMode {
  if (!override || override.fallback === undefined) return "default";
  if (override.fallback.length === 0) return "disabled";
  if (override.fallback.length === 1 && override.fallback[0] === "main") return "default";
  return "custom";
}

async function fetchCSRF(): Promise<string> {
  const res = await fetch("/settings/api/auth/csrf");
  const body = await res.json().catch(() => ({}));
  return (body.csrfToken as string) ?? "";
}

// ─── Row editor ────────────────────────────────────────────────────────────

interface RowState {
  branch: string;
  source: string;
  tag: string;
  artifactSHA256: string;
  fallbackMode: FallbackMode;
  fallbackChain: string;
  expanded: boolean;
  saving: boolean;
  message: string | null;
  error: string | null;
}

function initialRowState(entry: ComponentEntry): RowState {
  const ov = entry.override;
  const mode = deriveFallbackMode(ov);
  return {
    branch: ov?.branch ?? "",
    source: ov?.source ?? "",
    tag: ov?.tag ?? "",
    artifactSHA256: ov?.artifact_sha256 ?? "",
    fallbackMode: mode,
    fallbackChain: mode === "custom" ? (ov?.fallback ?? []).join(", ") : "",
    expanded: false,
    saving: false,
    message: null,
    error: null,
  };
}

function VersionCell({ label, value }: { label: string; value: VersionRef }) {
  const display = value.version ? formatVersion(value.version) : "—";
  const showBranch = value.branch && value.branch !== "main";
  return (
    <div className="min-w-[120px]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="font-mono text-[13px]">{display}</span>
        {showBranch && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
            {value.branch}
          </Badge>
        )}
      </div>
    </div>
  );
}

export function UpdateChannels({ appliance = false, componentId }: { appliance?: boolean; componentId?: string }) {
  const [data, setData] = useState<ChannelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Switch-confirm dialog target: the component id + candidate ref.
  const [switchTarget, setSwitchTarget] = useState<{ id: string; candidate: VersionRef; installed: VersionRef } | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/settings/api/updates/channels");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load update channels");
      setData(body as ChannelsResponse);
      // Seed row editor state from the fetched overrides (derived, no flash).
      const seeded: Record<string, RowState> = {};
      for (const [id, entry] of Object.entries((body as ChannelsResponse).components)) {
        seeded[id] = { ...initialRowState(entry), expanded: componentId === id };
      }
      setRows(seeded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load update channels");
    } finally {
      setLoading(false);
    }
  }, [componentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedIds = useMemo(
    () => (data ? orderComponents(Object.keys(data.components)).filter((id) => !(appliance && id === "spine") && (!componentId || id === componentId)) : []),
    [appliance, componentId, data],
  );

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function saveRow(id: string) {
    const row = rows[id];
    if (!row) return;
    patchRow(id, { saving: true, message: null, error: null });

    // Build the override channel from the editor. Empty branch/source means
    // "inherit" for that field; an all-empty override clears (null).
    const channel: ChannelOverride = {};
    if (row.branch.trim()) channel.branch = row.branch.trim();
    if (row.source.trim()) channel.source = row.source.trim();
    if (row.tag.trim()) channel.tag = row.tag.trim();
    if (row.artifactSHA256.trim()) channel.artifact_sha256 = row.artifactSHA256.trim().toLowerCase();
    if (row.fallbackMode === "disabled") {
      channel.fallback = [];
    } else if (row.fallbackMode === "custom") {
      channel.fallback = row.fallbackChain
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
    } else {
      channel.fallback = ["main"];
    }

    const payload: Record<string, ChannelOverride | null> =
      Object.keys(channel).length === 0 ? { [id]: null } : { [id]: channel };

    try {
      const csrf = await fetchCSRF();
      const res = await fetch("/settings/api/updates/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to save channel");
      patchRow(id, { saving: false, message: "Saved" });
      await load();
    } catch (err) {
      patchRow(id, { saving: false, error: err instanceof Error ? err.message : "Failed to save channel" });
    }
  }

  async function resetRow(id: string) {
    patchRow(id, { saving: true, message: null, error: null });
    try {
      const csrf = await fetchCSRF();
      const res = await fetch("/settings/api/updates/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ [id]: null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to reset channel");
      await load();
    } catch (err) {
      patchRow(id, { saving: false, error: err instanceof Error ? err.message : "Failed to reset channel" });
    }
  }

  async function confirmSwitch() {
    if (!switchTarget) return;
    setSwitching(true);
    // Map component id -> update endpoint. ui + apps go through the CP update
    // route; spine/control also accept confirm_switch via the same route.
    const component = switchTarget.id.startsWith("app:")
      ? switchTarget.id.slice("app:".length)
      : switchTarget.id;
    try {
      const csrf = await fetchCSRF();
      const res = await fetch(`/settings/api/updates/${component}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ confirm_switch: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Switch failed");
      setSwitchTarget(null);
      await load();
    } catch (err) {
      patchRow(switchTarget.id, { error: err instanceof Error ? err.message : "Switch failed" });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <GitBranch className="h-4 w-4" />
            {componentId ? "Update channel" : "Update channels"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {componentId ? "Choose the repository and release branch used when this app checks for updates." : "Choose which branch the Server interface, Dashboard, and native apps install from, and how they fall back."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      {loading && !data ? (
        <div className="flex justify-center rounded-lg border py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {orderedIds.map((id) => {
            const entry = data!.components[id];
            const row = rows[id];
            if (!row) return null;
            const branchLabel = entry.channel.branch;
            return (
              <div key={id} className="p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => patchRow(id, { expanded: !row.expanded })}
                      aria-label={row.expanded ? "Collapse" : "Expand"}
                    >
                      {row.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <div>
                      <div className="flex items-center gap-2 text-[14px] font-medium">
                        {labelFor(id)}
                        {branchLabel !== "main" && (
                          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                            {branchLabel}
                          </Badge>
                        )}
                      </div>
                      {id !== "default" && (
                        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                          {entry.update_available && !entry.switch_pending && (
                            <span className="flex items-center gap-1 text-green-600 dark:text-green-500">
                              Update available
                            </span>
                          )}
                          {entry.switch_pending && (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                              <ArrowRightLeft className="h-3 w-3" /> Switch pending
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {id !== "default" && <VersionCell label="Installed" value={entry.installed} />}
                    {id !== "default" && <VersionCell label="Candidate" value={entry.candidate} />}
                    {entry.switch_pending && entry.candidate.version && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSwitchTarget({ id, candidate: entry.candidate, installed: entry.installed })
                        }
                      >
                        <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />
                        Switch to {formatVersion(entry.candidate.version)}
                        {entry.candidate.branch ? ` (${entry.candidate.branch})` : ""}
                      </Button>
                    )}
                  </div>
                </div>

                {row.expanded && (
                  <div className="mt-3 space-y-3 border-t pt-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`source-${id}`}>Repo URL</Label>
                        <Input
                          id={`source-${id}`}
                          value={row.source}
                          placeholder={`inherit (${entry.channel.source})`}
                          onChange={(e) => patchRow(id, { source: e.target.value })}
                          disabled={row.saving}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`branch-${id}`}>Release branch / channel</Label>
                        <Input
                          id={`branch-${id}`}
                          value={row.branch}
                          placeholder={id === "default" ? "main" : `inherit (${entry.channel.branch})`}
                          onChange={(e) => patchRow(id, { branch: e.target.value })}
                          disabled={row.saving}
                        />
                      </div>
                    </div>

                    <details className="text-[13px]">
                      <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
                      <div className="mt-2 grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5 md:col-span-2">
                          <Label>Fallback branches</Label>
                          <div className="flex flex-wrap gap-1.5">
                            {(["default", "custom", "disabled"] as FallbackMode[]).map((mode) => (
                              <Button key={mode} type="button" size="sm" variant={row.fallbackMode === mode ? "default" : "outline"} onClick={() => patchRow(id, { fallbackMode: mode })} disabled={row.saving}>
                                {mode === "default" ? "Default (main)" : mode === "custom" ? "Custom chain" : "Disabled"}
                              </Button>
                            ))}
                          </div>
                          {row.fallbackMode === "custom" && <Input className="mt-1.5" value={row.fallbackChain} placeholder="main, dev" onChange={(e) => patchRow(id, { fallbackChain: e.target.value })} disabled={row.saving} />}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`tag-${id}`}>Exact release tag</Label>
                          <Input
                            id={`tag-${id}`}
                            value={row.tag}
                            placeholder="Optional"
                            onChange={(e) => patchRow(id, { tag: e.target.value })}
                            disabled={row.saving}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`digest-${id}`}>Artifact SHA-256</Label>
                          <Input
                            id={`digest-${id}`}
                            value={row.artifactSHA256}
                            placeholder="Optional exact digest"
                            className="font-mono"
                            onChange={(e) => patchRow(id, { artifactSHA256: e.target.value.toLowerCase() })}
                            disabled={row.saving}
                          />
                        </div>
                      </div>
                    </details>

                    <div className="flex items-center gap-3">
                      <Button size="sm" onClick={() => void saveRow(id)} disabled={row.saving}>
                        {row.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void resetRow(id)} disabled={row.saving || !entry.override}>Reset to default</Button>
                      {row.message && <span className="text-[13px] text-muted-foreground">{row.message}</span>}
                      {row.error && <span className="text-[13px] text-destructive">{row.error}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!switchTarget}
        title="Switch update channel?"
        description={
          switchTarget
            ? `This installs ${labelFor(switchTarget.id)} ${switchTarget.candidate.version ? formatVersion(switchTarget.candidate.version) : ""}` +
              `${switchTarget.candidate.branch ? ` from branch "${switchTarget.candidate.branch}"` : ""}` +
              `${
                switchTarget.installed.version
                  ? `, replacing the installed ${formatVersion(switchTarget.installed.version)}${
                      switchTarget.installed.branch && switchTarget.installed.branch !== "main"
                        ? ` (${switchTarget.installed.branch})`
                        : ""
                    }.`
                  : "."
              } This can be a downgrade — the new version may be numerically lower than what you have now.`
            : undefined
        }
        confirmLabel={switching ? "Switching…" : "Switch channel"}
        confirmDisabled={switching}
        onConfirm={() => void confirmSwitch()}
        onCancel={() => (switching ? undefined : setSwitchTarget(null))}
      />
    </div>
  );
}
