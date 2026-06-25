/**
 * Timeline Embed — Plan 1 Workstream E2.
 *
 * Renders a timeline entry as the source app's own embed via the ONE
 * <UnifiedEmbed> wrapper (kind="timeline-card"): lazy IntersectionObserver
 * mount, origin-validated `youeye:ready/resize/action` protocol (legacy
 * `youeye-embed-*` accepted for one cycle), timeout → visible fallback. The old
 * 200px height cap is gone — app-declared height up to a generous 480px guard.
 * Attribution (app chip + time) is rendered by the feed OUTSIDE the embed
 * (anti-impersonation). When the app has no embed, is uninstalled, or times out,
 * the StandardCard fallback is shown (never silent).
 */

"use client";

import { ExternalLink, Package } from "lucide-react";
import { UnifiedEmbed } from "@/components/embeds/unified-embed";
import { resolveLucideIcon } from "@/lib/timeline/icon-map";

// ─── App Meta (passed down from timeline feed) ─────────────────────

export interface AppMetaEntry {
  icon: string | null;
  accent_color: string | null;
  entry_icons: Record<string, string>;
  timeline_cards?: Record<string, { embed_path: string; name: string | null; description: string | null }>;
}

// ─── Standard Card Fallback ──────────────────────────────────────────

interface StandardCardData {
  app_id: string;
  entry_type: string;
  title: string;
  timestamp: string;
  data: Record<string, unknown>;
  tags: Record<string, unknown>;
}

/** Generate Tailwind-compatible border/bg classes from a hex accent color */
function accentClasses(hex: string | null | undefined): string {
  if (!hex) return "border-border bg-muted/30";
  return "border-[var(--accent-border)] bg-[var(--accent-bg)]";
}

function accentStyle(hex: string | null | undefined): React.CSSProperties {
  if (!hex) return {};
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    "--accent-border": `rgba(${r}, ${g}, ${b}, 0.4)`,
    "--accent-bg": `rgba(${r}, ${g}, ${b}, 0.05)`,
  } as React.CSSProperties;
}

function StandardCard({
  entry,
  meta,
  uninstalled,
}: {
  entry: StandardCardData;
  meta?: AppMetaEntry;
  uninstalled?: boolean;
}) {
  const Icon = meta?.icon ? resolveLucideIcon(meta.icon) : Package;
  const color = meta?.accent_color ?? null;
  const description = entry.data.description as string | undefined;
  const thumbnailUrl = entry.data.thumbnail_url as string | undefined;
  const url = entry.data.url as string | undefined;

  const appSlug = entry.app_id.replace(/^ye-/, "");
  const actionLabel = entry.entry_type
    .replace(new RegExp(`^${appSlug}-`), "")
    .replace(/-/g, " ");

  return (
    <div
      className={`flex gap-3 rounded-lg border p-3 ${accentClasses(color)}`}
      style={accentStyle(color)}
    >
      {thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt=""
          className="h-16 w-12 flex-shrink-0 rounded object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] capitalize text-muted-foreground">{appSlug}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{actionLabel}</span>
        </div>

        {entry.title && <p className="truncate text-sm font-medium text-foreground">{entry.title}</p>}

        {uninstalled ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            This app was uninstalled — the entry is kept from your timeline history.
          </p>
        ) : (
          description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
        )}

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            {(() => {
              try {
                return new URL(url).hostname.replace("www.", "");
              } catch {
                return url;
              }
            })()}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Timeline embed (on UnifiedEmbed) ────────────────────────────────

const EMBED_TIMEOUT_MS = 5000;
const EMBED_MIN_HEIGHT = 48;
const EMBED_MAX_HEIGHT = 480; // E2: the old 200px cap is gone — generous guard.

interface TimelineEmbedProps {
  entry: {
    app_id: string;
    entry_type: string;
    title: string;
    timestamp: string;
    embed_path?: string;
    tags: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  /** Base domain for app subdomains (e.g. "yourdomain.com") */
  domain: string;
  /** App metadata from manifest (icon, accent_color, entry_icons) */
  appMeta?: AppMetaEntry;
  /** Optional theme mode passed through to the embed (`?mode=`) for self-theming */
  mode?: "light" | "dark";
  className?: string;
}

export function TimelineEmbed({ entry, domain, appMeta, mode, className }: TimelineEmbedProps) {
  // No embed_path → always show the standard card.
  if (!entry.embed_path) {
    return (
      <div className={className}>
        <StandardCard entry={entry} meta={appMeta} />
      </div>
    );
  }

  const appSlug = entry.app_id.replace(/^ye-/, "");
  const embedUrl = `https://${appSlug}.${domain}${entry.embed_path}`;

  return (
    <UnifiedEmbed
      url={embedUrl}
      kind="timeline-card"
      size={{ default: EMBED_MIN_HEIGHT, min: EMBED_MIN_HEIGHT, max: EMBED_MAX_HEIGHT }}
      timeout={EMBED_TIMEOUT_MS}
      mode={mode}
      className={className}
      title={`${appSlug} timeline card`}
      fallback={<StandardCard entry={entry} meta={appMeta} uninstalled />}
    />
  );
}
