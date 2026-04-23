/**
 * Widget Container — shadcn/ui styled
 *
 * Wraps widgets with optional glass-morphism card styling,
 * drag handle, resize handles (edges + corners), and edit-mode controls.
 * Supports per-widget background styles: transparent (default), glass, custom.
 */
"use client";

import { useRef, useCallback, useState } from "react";
import { GripVertical, X, Settings2 } from "lucide-react";
import { WidgetCard } from "./widget-card";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const SNAP = 20;
const MIN_W = 60;
const MIN_H = 30;

function snapTo(value: number): number {
  return Math.round(value / SNAP) * SNAP;
}

export interface WidgetPosition {
  id: string;
  widgetType: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  order: number;
  settings: Record<string, unknown>;
}

interface WidgetContainerProps {
  widget: WidgetPosition;
  isEditMode: boolean;
  containerSize: { width: number; height: number };
  onPositionChange: (id: string, x: number, y: number) => void;
  onSizeChange: (id: string, w: number, h: number) => void;
  onRemove: (id: string) => void;
  onSettingsOpen?: (id: string) => void;
}

export function WidgetContainer({
  widget,
  isEditMode,
  containerSize,
  onPositionChange,
  onSizeChange,
  onRemove,
  onSettingsOpen,
}: WidgetContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const t = useTranslations('widgetGrid');

  const pxX = (widget.positionX / 100) * containerSize.width;
  const pxY = (widget.positionY / 100) * containerSize.height;
  const pxW = (widget.width / 100) * containerSize.width;
  const pxH = (widget.height / 100) * containerSize.height;

  const toPercent = useCallback(
    (px: number, dimension: "x" | "y") => {
      const total = dimension === "x" ? containerSize.width : containerSize.height;
      if (total === 0) return 0;
      return Math.max(0, Math.min(100, (px / total) * 100));
    },
    [containerSize]
  );

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const startMX = e.clientX;
      const startMY = e.clientY;
      const startX = pxX;
      const startY = pxY;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMX;
        const dy = ev.clientY - startMY;
        const newX = snapTo(startX + dx);
        const newY = snapTo(startY + dy);
        onPositionChange(widget.id, toPercent(newX, "x"), toPercent(newY, "y"));
      };

      const onUp = () => {
        setIsDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isEditMode, pxX, pxY, widget.id, onPositionChange, toPercent]
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, edges: { right?: boolean; bottom?: boolean; left?: boolean; top?: boolean }) => {
      if (!isEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);

      const startMX = e.clientX;
      const startMY = e.clientY;
      const startW = pxW;
      const startH = pxH;
      const startX = pxX;
      const startY = pxY;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMX;
        const dy = ev.clientY - startMY;

        let newW = startW;
        let newH = startH;
        let newX = startX;
        let newY = startY;

        if (edges.right) newW = Math.max(MIN_W, startW + dx);
        if (edges.bottom) newH = Math.max(MIN_H, startH + dy);
        if (edges.left) {
          newW = Math.max(MIN_W, startW - dx);
          newX = startX + (startW - newW);
        }
        if (edges.top) {
          newH = Math.max(MIN_H, startH - dy);
          newY = startY + (startH - newH);
        }

        newW = snapTo(newW);
        newH = snapTo(newH);
        newX = snapTo(newX);
        newY = snapTo(newY);

        onSizeChange(widget.id, toPercent(newW, "x"), toPercent(newH, "y"));
        onPositionChange(widget.id, toPercent(newX, "x"), toPercent(newY, "y"));
      };

      const onUp = () => {
        setIsResizing(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isEditMode, pxW, pxH, pxX, pxY, widget.id, onSizeChange, onPositionChange, toPercent]
  );

  const bgStyle = (widget.settings?.backgroundStyle as string) ?? "transparent";
  const customBgColor = (widget.settings?.customBackgroundColor as string) ?? undefined;

  const isTransparent = bgStyle === "transparent";
  const isGlass = bgStyle === "default" || bgStyle === "glass";
  const bgClasses = (() => {
    switch (bgStyle) {
      case "transparent":
        return "bg-transparent border-transparent shadow-none";
      case "custom":
        return "backdrop-blur-xl border-border/40";
      case "default":
      case "glass":
        return "bg-card/70 backdrop-blur-xl border-border/40";
      default:
        return "bg-transparent border-transparent shadow-none";
    }
  })();

  const inlineStyle: React.CSSProperties = {
    left: `${pxX}px`,
    top: `${pxY}px`,
    width: `${pxW}px`,
    height: `${pxH}px`,
    transition: isDragging || isResizing ? "none" : "box-shadow 0.2s, transform 0.15s",
    ...(bgStyle === "custom" && customBgColor ? { backgroundColor: customBgColor } : {}),
  };

  const HANDLE = 12; // px, resize handle hit zone

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute group",
        !isTransparent && "rounded-xl border shadow-lg",
        bgClasses,
        isDragging || isResizing ? "z-50 shadow-xl scale-[1.01]" : "z-10",
        isEditMode && "ring-1 ring-border/50 hover:ring-primary/60",
      )}
      style={inlineStyle}
    >
      {/* Drag handle — entire top bar in edit mode */}
      {isEditMode && (
        <div
          className="absolute -top-0.5 left-0 right-0 flex items-center justify-center h-7 cursor-grab active:cursor-grabbing z-20"
          onMouseDown={handleDragStart}
        >
          <GripVertical className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
        </div>
      )}

      {/* Remove button */}
      {isEditMode && (
        <button
          className="absolute -top-2 -right-2 z-30 w-5 h-5 rounded-full bg-destructive text-white flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onRemove(widget.id)}
          title={t('removeWidget')}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {/* Settings button */}
      {isEditMode && onSettingsOpen && (
        <button
          className="absolute -top-2 -left-2 z-30 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onSettingsOpen(widget.id)}
          title={t('widgetSettings')}
        >
          <Settings2 className="w-3 h-3" />
        </button>
      )}

      {/* Widget content — container-type: size enables cqw/cqh units inside widgets */}
      <div
        className={cn("w-full h-full overflow-hidden", !isTransparent && "rounded-xl p-4")}
        style={{ containerType: "size" }}
      >
        <WidgetCard widgetType={widget.widgetType} settings={widget.settings} />
      </div>

      {/* Resize handles — all edges and corners, visible in edit mode */}
      {isEditMode && (
        <>
          {/* Right edge */}
          <div
            className="absolute top-0 -right-1 w-3 h-full cursor-e-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, { right: true })}
          />
          {/* Bottom edge */}
          <div
            className="absolute -bottom-1 left-0 w-full h-3 cursor-s-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, { bottom: true })}
          />
          {/* Left edge */}
          <div
            className="absolute top-0 -left-1 w-3 h-full cursor-w-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, { left: true })}
          />
          {/* Top edge */}
          <div
            className="absolute -top-1 left-0 w-full h-3 cursor-n-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, { top: true })}
          />
          {/* Bottom-right corner */}
          <div
            className="absolute -bottom-1 -right-1 w-4 h-4 cursor-se-resize z-25"
            onMouseDown={(e) => handleResizeStart(e, { right: true, bottom: true })}
          >
            <svg viewBox="0 0 16 16" className="w-full h-full text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity">
              <path d="M14 14L6 14M14 14L14 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
          </div>
          {/* Bottom-left corner */}
          <div
            className="absolute -bottom-1 -left-1 w-4 h-4 cursor-sw-resize z-25"
            onMouseDown={(e) => handleResizeStart(e, { left: true, bottom: true })}
          />
          {/* Top-right corner */}
          <div
            className="absolute -top-1 -right-1 w-4 h-4 cursor-ne-resize z-25"
            onMouseDown={(e) => handleResizeStart(e, { right: true, top: true })}
          />
          {/* Top-left corner */}
          <div
            className="absolute -top-1 -left-1 w-4 h-4 cursor-nw-resize z-25"
            onMouseDown={(e) => handleResizeStart(e, { left: true, top: true })}
          />
        </>
      )}
    </div>
  );
}
