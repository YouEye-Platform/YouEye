export type SurfaceKind = "widget" | "info-card" | "timeline-card" | "notification" | "settings-panel";
export type SurfacePlacement = "dashboard" | "timeline" | "notification-center" | "app-settings" | "app-detail";

const SURFACE_KINDS = new Set<SurfaceKind>([
  "widget",
  "info-card",
  "timeline-card",
  "notification",
  "settings-panel",
]);

const SURFACE_PLACEMENTS = new Set<SurfacePlacement>([
  "dashboard",
  "timeline",
  "notification-center",
  "app-settings",
  "app-detail",
]);

export interface AppSurface {
  id: string;
  kind: SurfaceKind;
  placement: SurfacePlacement;
  name?: string;
  description?: string;
  embedPath: string;
  permissions: string[];
  defaultSize?: { width: number; height: number };
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  refreshInterval?: number;
  settingsSchema?: unknown[];
  triggers?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asSize(value: unknown): { width: number; height: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const width = Number(record.width);
  const height = Number(record.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

function normalizeSurface(raw: unknown): AppSurface | null {
  const surface = asRecord(raw);
  if (!surface) return null;

  const id = asString(surface.id);
  const kind = asString(surface.kind) as SurfaceKind | undefined;
  const placement = asString(surface.placement) as SurfacePlacement | undefined;
  const embedPath = asString(surface.embedPath) ?? asString(surface.embed_path);
  if (!id || !kind || !placement || !embedPath) return null;
  if (!SURFACE_KINDS.has(kind) || !SURFACE_PLACEMENTS.has(placement)) return null;

  return {
    id,
    kind,
    placement,
    name: asString(surface.name),
    description: asString(surface.description),
    embedPath,
    permissions: asStringArray(surface.permissions),
    defaultSize: asSize(surface.defaultSize ?? surface.default_size),
    minSize: asSize(surface.minSize ?? surface.min_size),
    maxSize: asSize(surface.maxSize ?? surface.max_size),
    refreshInterval: typeof surface.refreshInterval === "number"
      ? surface.refreshInterval
      : typeof surface.refresh_interval === "number"
        ? surface.refresh_interval
        : undefined,
    settingsSchema: Array.isArray(surface.settingsSchema)
      ? surface.settingsSchema
      : Array.isArray(surface.settings_schema)
        ? surface.settings_schema
        : undefined,
    triggers: asStringArray(surface.triggers),
  };
}

export function normalizeAppSurfaces(manifest: Record<string, unknown> | null | undefined): AppSurface[] {
  if (!manifest) return [];

  const surfaces: AppSurface[] = [];
  if (Array.isArray(manifest.surfaces)) {
    surfaces.push(...manifest.surfaces.map(normalizeSurface).filter((item): item is AppSurface => item !== null));
  }

  const byKey = new Map<string, AppSurface>();
  for (const surface of surfaces) {
    byKey.set(`${surface.kind}:${surface.placement}:${surface.id}`, surface);
  }
  return [...byKey.values()];
}
