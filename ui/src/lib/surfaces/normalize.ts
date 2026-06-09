export type SurfaceKind = "widget" | "info-card" | "timeline-card" | "notification";
export type SurfacePlacement = "dashboard" | "timeline" | "notification-center" | "app-settings" | "app-detail";

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
  legacySource?: "surfaces" | "widgets" | "info_cards" | "timeline_embeds" | "capabilities.notifications";
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
    legacySource: "surfaces",
  };
}

function legacyWidgetToSurface(raw: unknown): AppSurface | null {
  const widget = asRecord(raw);
  if (!widget) return null;
  const id = asString(widget.id);
  if (!id) return null;
  return {
    id,
    kind: "widget",
    placement: "dashboard",
    name: asString(widget.name) ?? id,
    description: asString(widget.description),
    embedPath: `/embed/widget/${encodeURIComponent(id)}`,
    permissions: [],
    defaultSize: asSize(widget.default_size),
    minSize: asSize(widget.min_size),
    maxSize: asSize(widget.max_size),
    refreshInterval: typeof widget.refresh_interval === "number" ? widget.refresh_interval : undefined,
    settingsSchema: Array.isArray(widget.settings_schema) ? widget.settings_schema : undefined,
    legacySource: "widgets",
  };
}

function legacyInfoCardToSurface(raw: unknown): AppSurface | null {
  const card = asRecord(raw);
  if (!card) return null;
  const id = asString(card.type) ?? asString(card.id);
  const embedPath = asString(card.embed_path) ?? asString(card.endpoint);
  if (!id || !embedPath) return null;
  return {
    id,
    kind: "info-card",
    placement: "timeline",
    name: asString(card.label) ?? id,
    description: asString(card.description),
    embedPath,
    permissions: [],
    triggers: asStringArray(card.triggers),
    legacySource: "info_cards",
  };
}

function legacyTimelineEmbedToSurface(raw: unknown): AppSurface | null {
  const embed = asRecord(raw);
  if (!embed) return null;
  const id = asString(embed.entry_type) ?? asString(embed.id);
  const embedPath = asString(embed.embed_path);
  if (!id || !embedPath) return null;
  return {
    id,
    kind: "timeline-card",
    placement: "timeline",
    name: id,
    description: asString(embed.description),
    embedPath,
    permissions: [],
    triggers: [id],
    legacySource: "timeline_embeds",
  };
}

export function normalizeAppSurfaces(manifest: Record<string, unknown> | null | undefined): AppSurface[] {
  if (!manifest) return [];

  const surfaces: AppSurface[] = [];
  if (Array.isArray(manifest.surfaces)) {
    surfaces.push(...manifest.surfaces.map(normalizeSurface).filter((item): item is AppSurface => item !== null));
  }
  if (Array.isArray(manifest.widgets)) {
    surfaces.push(...manifest.widgets.map(legacyWidgetToSurface).filter((item): item is AppSurface => item !== null));
  }
  if (Array.isArray(manifest.info_cards)) {
    surfaces.push(...manifest.info_cards.map(legacyInfoCardToSurface).filter((item): item is AppSurface => item !== null));
  }
  if (Array.isArray(manifest.timeline_embeds)) {
    surfaces.push(...manifest.timeline_embeds.map(legacyTimelineEmbedToSurface).filter((item): item is AppSurface => item !== null));
  }

  const hasCanonicalNotificationSurface = surfaces.some(
    (surface) => surface.kind === "notification" && surface.placement === "notification-center" && surface.legacySource === "surfaces",
  );
  const capabilities = asRecord(manifest.capabilities);
  if (!hasCanonicalNotificationSurface && (capabilities?.notifications === true || capabilities?.notifications === "push")) {
    surfaces.push({
      id: "default-notification",
      kind: "notification",
      placement: "notification-center",
      name: "Notification",
      description: "App-provided notification surface.",
      embedPath: "/embed/notification/default",
      permissions: ["notifications:send"],
      legacySource: "capabilities.notifications",
    });
  }

  const byKey = new Map<string, AppSurface>();
  for (const surface of surfaces) {
    byKey.set(`${surface.kind}:${surface.placement}:${surface.id}`, surface);
  }
  return [...byKey.values()];
}
