"use client";

import { type ReactNode, useEffect } from "react";

export function postOverlayClose() {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ type: "youeye:close" }, "*");
  }
}

export function postOpenLauncher() {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ type: "youeye:overlay-command", command: "open-launcher" }, "*");
  }
}

export function postUnreadCount(count: number) {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ type: "youeye:notifications", unread_count: count }, "*");
  }
}

export function EmbedOverlayShell({
  children,
  panelClassName,
  onClose = postOverlayClose,
}: {
  children: ReactNode;
  panelClassName: string;
  onClose?: () => void;
}) {
  useEffect(() => {
    document.documentElement.dataset.youeyeOverlayEmbed = "true";
    document.body.dataset.youeyeOverlayEmbed = "true";
    return () => {
      delete document.documentElement.dataset.youeyeOverlayEmbed;
      delete document.body.dataset.youeyeOverlayEmbed;
    };
  }, []);

  return (
    <div data-youeye-overlay-embed className="fixed inset-0 bg-transparent text-foreground">
      <button
        type="button"
        aria-label="Close overlay"
        className="absolute inset-0 block h-full w-full cursor-default bg-transparent"
        onClick={onClose}
      />
      <div
        className={panelClassName}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
