/**
 * useGridDrag — Plan 5 (Slice 2.5).
 *
 * Pointer-based drag for an icon grid, replacing HTML5 native DnD (which is
 * drop-only, has no live reflow, and can't be driven by tests). Gives:
 *  - **live reorder**: while dragging, the item moves to the hovered item's
 *    index every frame, so the grid reflows live;
 *  - a "lifted" ghost the caller renders at `ghost` (portal it to body to escape
 *    backdrop-filter containing blocks);
 *  - **dwell-to-merge**: pausing ~450ms over a mergeable item highlights it
 *    (`mergeTargetId`); releasing there fires `onMerge` (folder create/add).
 *
 * A press that doesn't move past the threshold stays a click — call
 * `consumeClick()` at the top of the tile's onClick to swallow the click that
 * follows a real drag.
 */

"use client";

import { useCallback, useRef, useState } from "react";

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
  /** Fired on drop over a dwelled merge target. */
  onMerge?: (draggedId: string, targetId: string) => void;
  dwellMs?: number;
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
  optsRef.current = opts;

  const pending = useRef<{ id: string; x: number; y: number } | null>(null);
  const active = useRef(false);
  const mergeRef = useRef<string | null>(null);
  const dwell = useRef<{ id: string | null; t: ReturnType<typeof setTimeout> | null }>({ id: null, t: null });
  const suppressClick = useRef(false);

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

  const clearDwell = () => {
    if (dwell.current.t) clearTimeout(dwell.current.t);
    dwell.current = { id: null, t: null };
  };

  const onMove = useCallback((e: PointerEvent) => {
    const p = pending.current;
    if (!p) return;
    if (!active.current) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
      active.current = true;
      setDraggingId(p.id);
    }
    setGhost({ x: e.clientX, y: e.clientY });

    const o = optsRef.current;
    let overId: string | null = null;
    let center = false;
    for (const [id, el] of els.current) {
      if (id === p.id) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        overId = id;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        center = Math.abs(e.clientX - cx) <= r.width * 0.3 && Math.abs(e.clientY - cy) <= r.height * 0.3;
        break;
      }
    }

    if (overId) {
      const mergeable = !!o.onMerge && (o.canMerge ? o.canMerge(p.id, overId) : true);
      if (mergeable && center) {
        if (dwell.current.id !== overId) {
          clearDwell();
          const target = overId;
          dwell.current.id = target;
          dwell.current.t = setTimeout(() => { mergeRef.current = target; setMergeTargetId(target); }, o.dwellMs ?? 450);
        }
      } else {
        clearDwell();
        if (mergeRef.current) { mergeRef.current = null; setMergeTargetId(null); }
        const idx = o.order.indexOf(overId);
        if (idx >= 0) o.onReorder(p.id, idx);
      }
    } else {
      clearDwell();
      if (mergeRef.current) { mergeRef.current = null; setMergeTargetId(null); }
    }
  }, []);

  const onUp = useCallback(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    clearDwell();
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
  }, [onMove]);

  const startDrag = useCallback((e: React.PointerEvent, id: string) => {
    if (optsRef.current.enabled === false) return;
    // Only primary button / touch / pen.
    if (e.button !== undefined && e.button !== 0) return;
    pending.current = { id, x: e.clientX, y: e.clientY };
    active.current = false;
    // Capture the pointer on the tile: guarantees pointermove/up fire (and bubble
    // to window) AND stops the browser starting a native image/text drag — the
    // thing that otherwise fires pointercancel and kills a real-mouse drag.
    const el = els.current.get(id);
    if (el && e.pointerId !== undefined) {
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [onMove, onUp]);

  return { draggingId, ghost, mergeTargetId, register, startDrag, consumeClick };
}
