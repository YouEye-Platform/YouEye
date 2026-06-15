/**
 * NotificationItem — Plan 1 Workstream E3.
 *
 * One notification rendered to the `notifications.html` shape, shared by the bell
 * popover and the full /notifications page:
 *   - an unread blue dot at the left edge,
 *   - a `.via` attribution row (16px app chip + app name + time) rendered by the UI
 *     OUTSIDE the embed (anti-impersonation) with a hover-revealed dismiss,
 *   - a body that is the app's own <UnifiedEmbed kind="notification"> when it declares
 *     a notification surface, otherwise the standard fallback row. The embed's
 *     timeout fallback is that same standard row — never silent.
 */

"use client";

import {
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { resolveLucideIcon } from "@/lib/timeline/icon-map";
import { NotificationSurfaceEmbed } from "./notification-surface-embed";
import { NotificationStandardRow } from "./notification-standard-row";

export interface NotificationAppMeta {
  icon: string | null;
  accent_color: string | null;
}

export interface NotificationData {
  id: string;
  type: string;
  title: string;
  message: string | null;
  appId: string | null;
  read: boolean;
  createdAt: string;
  action: { type?: string; url?: string; label?: string } | null;
  surface?: {
    surface_id: string;
    embed_path: string;
    name: string | null;
    description: string | null;
  };
}

interface NotificationItemProps {
  notif: NotificationData;
  appMeta?: Record<string, NotificationAppMeta>;
  onAction?: (notif: NotificationData) => void;
  onDismiss?: (id: string) => void;
  mode?: "light" | "dark";
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

/** Soft-tinted chip from a hex accent (bg ~12%, fg full) — matches `.via .mini`. */
function chipStyle(hex: string | null | undefined): React.CSSProperties | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { background: `rgba(${r}, ${g}, ${b}, 0.12)`, color: hex };
}

export function NotificationItem({
  notif,
  appMeta,
  onAction,
  onDismiss,
  mode,
}: NotificationItemProps) {
  const t = useTranslations("notifications");

  const meta = notif.appId ? appMeta?.[notif.appId] : undefined;
  const isSystem = !notif.appId;
  const appName = isSystem
    ? t("system")
    : (() => {
        const s = notif.appId!.replace(/^ye-/, "");
        return s.charAt(0).toUpperCase() + s.slice(1);
      })();

  // Chip icon: app icon from manifest > notification-type icon > settings (System).
  const ChipIcon: LucideIcon = meta?.icon
    ? resolveLucideIcon(meta.icon)
    : isSystem
      ? Settings
      : TYPE_ICONS[notif.type] ?? Info;
  const chip = chipStyle(meta?.accent_color);

  const timeAgo = (() => {
    const seconds = Math.floor((Date.now() - new Date(notif.createdAt).getTime()) / 1000);
    if (seconds < 60) return t("justNow");
    if (seconds < 3600) return t("minutesAgo", { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return t("hoursAgo", { count: Math.floor(seconds / 3600) });
    return t("daysAgo", { count: Math.floor(seconds / 86400) });
  })();

  const standardRow = (
    <NotificationStandardRow
      Icon={ChipIcon}
      title={notif.title}
      message={notif.message}
      action={notif.action}
      actionLabel={t("view")}
      onAction={() => onAction?.(notif)}
    />
  );

  return (
    <div className="group relative grid gap-1.5">
      {/* unread blue dot at the left edge */}
      {!notif.read && (
        <span
          aria-hidden
          className="absolute -left-2 top-1.5 h-1.5 w-1.5 rounded-full bg-primary"
        />
      )}

      {/* attribution row (.via) — UI-rendered, outside the embed */}
      <div className="flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted-foreground">
        <span
          className="grid h-4 w-4 place-items-center rounded bg-accent text-muted-foreground"
          style={chip}
        >
          <ChipIcon className="h-2.5 w-2.5" />
        </span>
        <span className="font-medium text-foreground/90">{appName}</span>
        <time className="ml-auto tabular-nums">{timeAgo}</time>
        {onDismiss && (
          <button
            type="button"
            onClick={() => onDismiss(notif.id)}
            className="rounded p-0.5 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            aria-label={t("dismiss")}
            title={t("dismiss")}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* body — the app's notification embed (with std-row fallback) or the std row */}
      {notif.surface ? (
        <NotificationSurfaceEmbed
          notificationId={notif.id}
          appId={notif.appId}
          surface={notif.surface}
          fallback={standardRow}
          mode={mode}
        />
      ) : (
        standardRow
      )}
    </div>
  );
}
