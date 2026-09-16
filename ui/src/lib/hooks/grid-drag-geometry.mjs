/**
 * Classify the current pointer position for an icon grid. A mergeable centre
 * always wins over reordering so the target cannot jump out from under a drop.
 */
export function classifyGridPointer(draggedId, x, y, rects, order, canMerge) {
  for (const rect of rects) {
    if (rect.id === draggedId) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const inMergeCentre = Math.abs(x - cx) <= rect.width * 0.42
      && Math.abs(y - cy) <= rect.height * 0.42;
    if (inMergeCentre && canMerge(draggedId, rect.id)) {
      return { kind: "merge", targetId: rect.id };
    }

    const toIndex = order.indexOf(rect.id);
    return toIndex >= 0
      ? { kind: "reorder", targetId: rect.id, toIndex }
      : { kind: "none" };
  }
  return { kind: "none" };
}
