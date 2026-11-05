"use client";






import { useTranslations as useInterfaceTranslations } from "next-intl";
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




// Fixed display order for core components; apps follow, alphabetically.
const CORE_ORDER = ["default", "system", "spine", "control", "ui"];

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
  const translateInterface = useInterfaceTranslations("interface");
const COMPONENT_LABELS: Record<string, string> = {
  default: translateInterface("m6d8b5ac054d6"),
  system: translateInterface("m2a1ec4ff37ff"),
  spine: translateInterface("m6a81c94a4745"),
  control: translateInterface("m0d6a16e62a51"),
  ui: translateInterface("m67b696468610"),
};

function labelFor(id: string): string {
  if (COMPONENT_LABELS[id]) return COMPONENT_LABELS[id];
  if (id.startsWith("app:")) return id.slice("app:".length);
  return id;
}


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
      if (!res.ok) throw new Error(body.error || translateInterface("m4629a02438be"));
      setData(body as ChannelsResponse);
      // Seed row editor state from the fetched overrides (derived, no flash).
      const seeded: Record<string, RowState> = {};
      for (const [id, entry] of Object.entries((body as ChannelsResponse).components)) {
        seeded[id] = { ...initialRowState(entry), expanded: componentId === id };
      }
      setRows(seeded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : translateInterface("m4629a02438be"));
    } finally {
      setLoading(false);
    }
  }, [componentId, translateInterface]);

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
      if (!res.ok) throw new Error(body.error || translateInterface("m47cd80f434cc"));
      patchRow(id, { saving: false, message: translateInterface("mb5c120b316c2") });
      await load();
    } catch (err) {
      patchRow(id, { saving: false, error: err instanceof Error ? err.message : translateInterface("m47cd80f434cc") });
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
      if (!res.ok) throw new Error(body.error || translateInterface("m141451f7fd52"));
      await load();
    } catch (err) {
      patchRow(id, { saving: false, error: err instanceof Error ? err.message : translateInterface("m141451f7fd52") });
    }
  }

  async function confirmSwitch() {
    if (!switchTarget || switchTarget.id === "system") return;
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
      if (!res.ok) throw new Error(body.error || translateInterface("ma78caba8b7ef"));
      setSwitchTarget(null);
      await load();
    } catch (err) {
      patchRow(switchTarget.id, { error: err instanceof Error ? err.message : translateInterface("ma78caba8b7ef") });
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
            {componentId ? translateInterface("md4fc42307306") : translateInterface("m4e0c4a0aa248")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {componentId ? translateInterface("m940ecd90bdb4") : translateInterface("mbae1c928c41c")}
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
                      aria-label={row.expanded ? translateInterface("mbe6eb1fc3b05") : translateInterface("m07548c2c6511")}
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
                              {translateInterface("mff8b555d818f")}</span>
                          )}
                          {entry.switch_pending && (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                              <ArrowRightLeft className="h-3 w-3" /> {translateInterface("m0e9df043cadf")}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {id !== "default" && <VersionCell label={translateInterface("mf8b32f4e92bd")} value={entry.installed} />}
                    {id !== "default" && <VersionCell label={translateInterface("mb2452d1eba32")} value={entry.candidate} />}
                    {id !== "system" && entry.switch_pending && entry.candidate.version && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSwitchTarget({ id, candidate: entry.candidate, installed: entry.installed })
                        }
                      >
                        <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />
                        {translateInterface("m71b71bcf2818")}{formatVersion(entry.candidate.version)}
                        {entry.candidate.branch ? ` (${entry.candidate.branch})` : ""}
                      </Button>
                    )}
                  </div>
                </div>

                {row.expanded && (
                  <div className="mt-3 space-y-3 border-t pt-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`source-${id}`}>{translateInterface("mde5c1d1e3353")}</Label>
                        <Input
                          id={`source-${id}`}
                          value={row.source}
                          placeholder={translateInterface("m9edaf387d33b", { value0: String(entry.channel.source) })}
                          onChange={(e) => patchRow(id, { source: e.target.value })}
                          disabled={row.saving}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`branch-${id}`}>{translateInterface("m3e0a287758a7")}</Label>
                        <Input
                          id={`branch-${id}`}
                          value={row.branch}
                          placeholder={id === "default" ? "main" : translateInterface("m9edaf387d33b", { value0: String(entry.channel.branch) })}
                          onChange={(e) => patchRow(id, { branch: e.target.value })}
                          disabled={row.saving}
                        />
                      </div>
                    </div>

                    <details className="text-[13px]">
                      <summary className="cursor-pointer text-muted-foreground">{translateInterface("m9f088dbebd6c")}</summary>
                      <div className="mt-2 grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5 md:col-span-2">
                          <Label>{translateInterface("m8af3a2cae712")}</Label>
                          <div className="flex flex-wrap gap-1.5">
                            {(["default", "custom", "disabled"] as FallbackMode[]).map((mode) => (
                              <Button key={mode} type="button" size="sm" variant={row.fallbackMode === mode ? "default" : "outline"} onClick={() => patchRow(id, { fallbackMode: mode })} disabled={row.saving}>
                                {mode === "default" ? translateInterface("m0bbc7109e6cd") : mode === "custom" ? translateInterface("ma913ec01bd04") : translateInterface("m75081b593d15")}
                              </Button>
                            ))}
                          </div>
                          {row.fallbackMode === "custom" && <Input className="mt-1.5" value={row.fallbackChain} placeholder="main, dev" onChange={(e) => patchRow(id, { fallbackChain: e.target.value })} disabled={row.saving} />}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`tag-${id}`}>{translateInterface("m8c1894f16c3b")}</Label>
                          <Input
                            id={`tag-${id}`}
                            value={row.tag}
                            placeholder={translateInterface("m59be71333c96")}
                            onChange={(e) => patchRow(id, { tag: e.target.value })}
                            disabled={row.saving}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`digest-${id}`}>{translateInterface("m6dde0ae26cb0")}</Label>
                          <Input
                            id={`digest-${id}`}
                            value={row.artifactSHA256}
                            placeholder={translateInterface("m91ed372c1de3")}
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
                        {translateInterface("m1509f561f241")}</Button>
                      <Button size="sm" variant="outline" onClick={() => void resetRow(id)} disabled={row.saving || !entry.override}>{translateInterface("mbc5b45ae7b60")}</Button>
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
        title={translateInterface("mafad80debe2e")}
        description={
          switchTarget
            ? translateInterface("md8939907445b", {component: labelFor(switchTarget.id), candidate: switchTarget.candidate.version ? formatVersion(switchTarget.candidate.version) : "—", branch: switchTarget.candidate.branch || "—", installed: switchTarget.installed.version ? formatVersion(switchTarget.installed.version) + (switchTarget.installed.branch ? " (" + switchTarget.installed.branch + ")" : "") : "—"})
            : undefined
        }
        confirmLabel={switching ? translateInterface("mb7b9fbf8df28") : translateInterface("m716970972267")}
        confirmDisabled={switching}
        onConfirm={() => void confirmSwitch()}
        onCancel={() => (switching ? undefined : setSwitchTarget(null))}
      />
    </div>
  );
}
