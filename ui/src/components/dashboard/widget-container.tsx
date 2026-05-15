/**
 * Widget Container — shadcn/ui styled
 *
 * Wraps widgets with optional glass-morphism card styling,
 * drag handle, resize handles (edges + corners), and edit-mode controls.
 * Supports per-widget background styles: transparent (default), glass, custom.
 *
 * Auto-fit widgets (autoFit: true in WidgetMeta) have height managed by the
 * widget component itself — only width resize handles are shown in edit mode,
 * and the widget reports its ideal height via onAutoSize.
 */
"use client";

import { useRef, useCallback, useState } from "react";
import { X, Settings2 } from "lucide-react";
import { WidgetCard } from "./widget-card";
import { getWidgetMeta } from "@/components/widgets";
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

  const meta = getWidgetMeta(widget.widgetType);
  const isAutoFit = meta?.autoFit ?? false;
  const allowOverflow = meta?.allowOverflow ?? false;

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

  // Auto-fit: widget reports its ideal content height in pixels
  const handleAutoSize = useCallback(
    (size: { height: number }) => {
      if (!isAutoFit || containerSize.height <= 0) return;
      const heightPct = toPercent(size.height, "y");
      // Only adjust if meaningfully different to avoid save loops
      if (Math.abs(heightPct - widget.height) > 0.5) {
        onSizeChange(widget.id, widget.width, heightPct);
      }
    },
    [isAutoFit, containerSize.height, widget.id, widget.width, widget.height, toPercent, onSizeChange]
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
        // For autoFit widgets, ignore vertical resize — height is auto-managed
        if (!isAutoFit && edges.bottom) newH = Math.max(MIN_H, startH + dy);
        if (edges.left) {
          newW = Math.max(MIN_W, startW - dx);
          newX = startX + (startW - newW);
        }
        if (!isAutoFit && edges.top) {
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
    [isEditMode, isAutoFit, pxW, pxH, pxX, pxY, widget.id, onSizeChange, onPositionChange, toPercent]
  );

  const bgStyle = (widget.settings?.backgroundStyle as string) ?? "transparent";
  const customBgColor = (widget.settings?.customBackgroundColor as string) ?? undefined;

  const isTransparent = bgStyle === "transparent";
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

  // AutoFit widgets get minimal padding (p-1) even with non-transparent backgrounds
  const paddingClass = isAutoFit ? "p-1" : "p-4";

  const inlineStyle: React.CSSProperties = {
    left: `${pxX}px`,
    top: `${pxY}px`,
    width: `${pxW}px`,
    height: `${pxH}px`,
    transition: isDragging || isResizing ? "none" : "box-shadow 0.2s, transform 0.15s",
    ...(bgStyle === "custom" && customBgColor ? { backgroundColor: customBgColor } : {}),
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute group",
        !isTransparent && "rounded-xl border shadow-lg",
        bgClasses,
        isDragging || isResizing ? "z-50 shadow-xl scale-[1.01]" : "z-10",
      )}
      style={inlineStyle}
    >
      {/* Edit-mode dashed outline — clear visual indicator that widget is editable */}
      {isEditMode && (
        <div
          className={cn(
            "absolute -inset-px rounded-xl border-2 border-dashed pointer-events-none z-20 transition-colors",
            isDragging || isResizing
              ? "border-primary"
              : "border-muted-foreground/30 group-hover:border-primary/60",
          )}
        />
      )}

      {/* Remove button — above overlay and resize handles */}
      {isEditMode && (
        <button
          className="absolute -top-2 right-2 z-50 w-6 h-6 rounded-full bg-destructive text-white flex items-center justify-center shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onRemove(widget.id)}
          onMouseDown={(e) => e.stopPropagation()}
          title={t('removeWidget')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Settings button — above overlay and resize handles */}
      {isEditMode && onSettingsOpen && (
        <button
          className="absolute -top-2 left-2 z-50 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onSettingsOpen(widget.id)}
          onMouseDown={(e) => e.stopPropagation()}
          title={t('widgetSettings')}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Widget content — container-type: size enables cqw/cqh units inside widgets */}
      <div
        className={cn("w-full h-full", allowOverflow ? "overflow-visible" : "overflow-hidden", !isTransparent && `rounded-xl ${paddingClass}`)}
        style={{ containerType: "size" }}
      >
        <WidgetCard
          widgetType={widget.widgetType}
          settings={widget.settings}
          onAutoSize={isAutoFit ? handleAutoSize : undefined}
        />
      </div>

      {/* Edit-mode overlay — blocks iframe mouse capture during drag/resize.
          Without this, iframes inside app widgets steal mousemove events,
          making it impossible to resize or drag when cursor is over the iframe.
          Also acts as the drag surface so the entire widget body is draggable. */}
      {isEditMode && (
        <div
          className="absolute inset-0 z-[25] cursor-grab active:cursor-grabbing"
          onMouseDown={handleDragStart}
        />
      )}

      {/* Resize handles — visible in edit mode with corner dots */}
      {isEditMode && (
        <>
          {/* Edge handles — invisible hit areas along each edge */}
          {/* Right edge */}
          <div
            className="absolute top-2 -right-1.5 w-4 bottom-2 cursor-e-resize z-30"
            onMouseDown={(e) => handleResizeStart(e, { right: true })}
          />
          {/* Left edge */}
          <div
            className="absolute top-2 -left-1.5 w-4 bottom-2 cursor-w-resize z-30"
            onMouseDown={(e) => handleResizeStart(e, { left: true })}
          />

          {/* Right edge midpoint dot */}
          <div
            className="absolute top-1/2 -right-1 -translate-y-1/2 w-2 h-2 rounded-full bg-primary/50 group-hover:bg-primary transition-colors pointer-events-none z-30"
          />
          {/* Left edge midpoint dot */}
          <div
            className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-2 rounded-full bg-primary/50 group-hover:bg-primary transition-colors pointer-events-none z-30"
          />

          {/* Bottom, top edges + corners — only for non-autoFit widgets */}
          {!isAutoFit && (
            <>
              {/* Bottom edge */}
              <div
                className="absolute -bottom-1.5 left-2 right-2 h-4 cursor-s-resize z-30"
                onMouseDown={(e) => handleResizeStart(e, { bottom: true })}
              />
              {/* Top edge */}
              <div
                className="absolute -top-1.5 left-2 right-2 h-4 cursor-n-resize z-30"
                onMouseDown={(e) => handleResizeStart(e, { top: true })}
              />

              {/* Bottom edge midpoint dot */}
              <div
                className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-primary/50 group-hover:bg-primary transition-colors pointer-events-none z-30"
              />
              {/* Top edge midpoint dot */}
              <div
                className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-primary/50 group-hover:bg-primary transition-colors pointer-events-none z-30"
              />

              {/* Corner handles — visible dots with larger hit areas */}
              {/* SE corner */}
              <div
                className="absolute -bottom-2 -right-2 w-5 h-5 cursor-se-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { right: true, bottom: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              {/* SW corner */}
              <div
                className="absolute -bottom-2 -left-2 w-5 h-5 cursor-sw-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { left: true, bottom: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              {/* NE corner */}
              <div
                className="absolute -top-2 -right-2 w-5 h-5 cursor-ne-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { right: true, top: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              {/* NW corner */}
              <div
                className="absolute -top-2 -left-2 w-5 h-5 cursor-nw-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { left: true, top: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
            </>
          )}

          {/* AutoFit widgets still get left/right corner handles for horizontal resize */}
          {isAutoFit && (
            <>
              {/* Right-side corners — horizontal resize only */}
              <div
                className="absolute -top-2 -right-2 w-5 h-5 cursor-e-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { right: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              <div
                className="absolute -bottom-2 -right-2 w-5 h-5 cursor-e-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { right: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              {/* Left-side corners — horizontal resize only */}
              <div
                className="absolute -top-2 -left-2 w-5 h-5 cursor-w-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { left: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
              <div
                className="absolute -bottom-2 -left-2 w-5 h-5 cursor-w-resize z-40 flex items-center justify-center"
                onMouseDown={(e) => handleResizeStart(e, { left: true })}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-primary/50 group-hover:bg-primary transition-colors" />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
