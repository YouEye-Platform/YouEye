"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * ConfirmDialog — minimal dependency-free confirm modal (CP has no Dialog
 * primitive). Overlay + centered panel, Cancel / Confirm, optional checkbox
 * children. Used for guarded actions like system-app updates.
 */
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDisabled,
  destructive = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
      >
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        {children && <div className="mt-4 space-y-2.5">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} size="sm" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
