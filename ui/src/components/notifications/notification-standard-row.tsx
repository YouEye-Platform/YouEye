/**
 * NotificationStandardRow — Plan 1 Workstream E3.
 *
 * The `.std` fallback row from `notifications.html`: a 30px icon tile + bold
 * title + description + optional action link. Used for notifications that have
 * no embed surface (external/Market-installed apps, System notices) AND as the
 * <UnifiedEmbed kind="notification"> timeout fallback (never silent).
 */

"use client";

import type { LucideIcon } from "lucide-react";

export interface NotificationStandardRowProps {
  Icon: LucideIcon;
  title: string;
  message?: string | null;
  action?: { label?: string; url?: string } | null;
  /** Called when the action link is followed (so the parent can mark-read). */
  onAction?: () => void;
  actionLabel?: string;
}

export function NotificationStandardRow({
  Icon,
  title,
  message,
  action,
  onAction,
  actionLabel,
}: NotificationStandardRowProps) {
  return (
    <div className="flex items-start gap-[11px] rounded-xl border bg-card px-3.5 py-3">
      <div className="grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-[15px] w-[15px]" />
      </div>
      <div className="grid gap-0.5 leading-snug">
        <b className="text-[13px] font-semibold text-foreground">{title}</b>
        {message && <span className="text-[12.5px] text-muted-foreground">{message}</span>}
        {action?.url && (
          <a
            href={action.url}
            onClick={onAction}
            className="mt-0.5 text-[12.5px] text-primary hover:underline"
          >
            {action.label ?? actionLabel ?? "Open"}
          </a>
        )}
      </div>
    </div>
  );
}
