/**
 * useGridDrag — Plan 5 (Slice 2.5).
 *
 * Pointer-based drag for an icon grid, replacing HTML5 native DnD (which is
 * drop-only, has no live reflow, and can't be driven by tests). Gives:
 *  - **live reorder**: while dragging, the item moves to a deliberately
 *    hovered item's index, so passing across an icon does not instantly push
 *    the intended folder target out of the way;
 *  - a "lifted" ghost the caller renders at `ghost` (portal it to body to escape
 *    backdrop-filter containing blocks);
 *  - **center-to-merge**: the central area of a mergeable target highlights
 *    immediately (`mergeTargetId`); releasing there fires `onMerge`.
 *
 * A press that doesn't move past the threshold stays a click — call
 * `consumeClick()` at the top of the tile's onClick to swallow the click that
 * follows a real drag.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyGridPointer } from "./grid-drag-geometry.mjs";

/** Minimal shape of a pointer event (avoids depending on the React namespace in a .ts file). */
type PointerLike = { clientX: number; clientY: number; button?: number; pointerId?: number };

export interface UseGridDragOptions {
  /** Current ordered ids of the draggable items (kept fresh via ref). */
  order: string[];
  enabled?: boolean;
  /** Live: move `id` to `toIndex` in the order (caller updates local state only). */
  onReorder: (id: string, toIndex: number) => void;
  /** Persist the final order on drop (no merge happened). */
  onCommit?: () => void;
  /** Whether `draggedId` may merge into `targetId` (e.g. app→app or app→folder). */
  canMerge?: (draggedId: string, targetId: string) => boolean;
  /** Fired on drop over the central area of a merge target. */
  onMerge?: (draggedId: string, targetId: string) => void;
  /** Delay before an edge hover reorders. Lets a pointer cross into the merge centre first. */
  reorderDelayMs?: number;
}

export interface GridDragState {
  draggingId: string | null;
  ghost: { x: number; y: number } | null;
  mergeTargetId: string | null;
  register: (id: string) => (el: HTMLElement | null) => void;
  startDrag: (e: PointerLike, id: string) => void;
  /** Returns true (and resets) if the click should be suppressed (followed a drag). */
  consumeClick: () => boolean;
}

const THRESHOLD = 5;

export function useGridDrag(opts: UseGridDragOptions): GridDragState {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);

  const els = useRef(new Map<string, HTMLElement>());
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const pending = useRef<{ id: string; x: number; y: number } | null>(null);
  const active = useRef(false);
  const mergeRef = useRef<string | null>(null);
  const reorderDwell = useRef<{ id: string | null; t: ReturnType<typeof setTimeout> | null }>({ id: null, t: null });
  const suppressClick = useRef(false);
  const onUpRef = useRef<() => void>(() => {});
  const onUpEvent = useCallback(() => onUpRef.current(), []);

  // Stable ref-callback per id (avoids churn while the grid re-renders during a drag).
  const refCbs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const register = useCallback((id: string) => {
    let cb = refCbs.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id); };
      refCbs.current.set(id, cb);
    }
    return cb;
  }, []);

  const consumeClick = useCallback(() => {
    if (suppressClick.current) { suppressClick.current = false; return true; }
    return false;
  }, []);

  const clearReorderDwell = () => {
    if (reorderDwell.current.t) clearTimeout(reorderDwell.current.t);
    reorderDwell.current = { id: null, t: null };
  };

  const onMove = useCallback((e: PointerEvent | MouseEvent) => {
    const p = pending.current;
    if (!p) return;
    if (!active.current) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
      active.current = true;
      setDraggingId(p.id);
    }
    setGhost({ x: e.clientX, y: e.clientY });

    const o = optsRef.current;
    const rects = [];
    for (const [id, el] of els.current) {
      const r = el.getBoundingClientRect();
      rects.push({ id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    }
    const decision = classifyGridPointer(
      p.id,
      e.clientX,
      e.clientY,
      rects,
      o.order,
      (draggedId, targetId) => !!o.onMerge && (o.canMerge ? o.canMerge(draggedId, targetId) : true),
    );

    if (decision.kind === "merge") {
      clearReorderDwell();
      mergeRef.current = decision.targetId;
      setMergeTargetId(decision.targetId);
      return;
    }

    if (mergeRef.current) { mergeRef.current = null; setMergeTargetId(null); }
    if (decision.kind === "reorder") {
      if (reorderDwell.current.id === decision.targetId) return;
      clearReorderDwell();
      const delay = o.reorderDelayMs ?? 0;
      if (delay <= 0) {
        o.onReorder(p.id, decision.toIndex);
        return;
      }
      const targetId = decision.targetId;
      reorderDwell.current.id = targetId;
      reorderDwell.current.t = setTimeout(() => {
        const latest = optsRef.current;
        const toIndex = latest.order.indexOf(targetId);
        if (toIndex >= 0 && pending.current?.id === p.id) latest.onReorder(p.id, toIndex);
        reorderDwell.current = { id: null, t: null };
      }, delay);
    } else {
      clearReorderDwell();
      if (mergeRef.current) { mergeRef.current = null; setMergeTargetId(null); }
    }
  }, []);

  const onUp = useCallback(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUpEvent);
    window.removeEventListener("pointercancel", onUpEvent);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUpEvent);
    clearReorderDwell();
    const o = optsRef.current;
    const p = pending.current;
    if (active.current && p) {
      suppressClick.current = true;
      if (mergeRef.current && o.onMerge) o.onMerge(p.id, mergeRef.current);
      else o.onCommit?.();
    }
    pending.current = null;
    active.current = false;
    mergeRef.current = null;
    setDraggingId(null);
    setGhost(null);
    setMergeTargetId(null);
  }, [onMove, onUpEvent]);
  useEffect(() => {
    onUpRef.current = onUp;
  }, [onUp]);

  const startDrag = useCallback((e: PointerLike, id: string) => {
    if (optsRef.current.enabled === false) return;
    // Only primary button.
    if (e.button !== undefined && e.button !== 0) return;
    // Dedup: a real mouse fires BOTH pointerdown and mousedown — first one wins.
    if (pending.current) return;
    pending.current = { id, x: e.clientX, y: e.clientY };
    active.current = false;
    // Capture the pointer on the tile: guarantees pointermove/up fire (and bubble
    // to window) AND stops the browser starting a native image/text drag — the
    // thing that otherwise fires pointercancel and kills a real-mouse drag.
    const el = els.current.get(id);
    if (el && e.pointerId !== undefined) {
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    // Listen for both pointer and mouse streams (mouse is the fallback for
    // environments — incl. some automation — that don't emit pointer events).
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUpEvent);
    window.addEventListener("pointercancel", onUpEvent);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUpEvent);
  }, [onMove, onUpEvent]);

  return { draggingId, ghost, mergeTargetId, register, startDrag, consumeClick };
}
