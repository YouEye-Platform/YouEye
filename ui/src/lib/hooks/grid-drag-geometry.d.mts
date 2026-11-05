export interface GridTargetRect {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export type GridPointerDecision =
  | { kind: "merge"; targetId: string }
  | { kind: "reorder"; targetId: string; toIndex: number }
  | { kind: "none" };

export function classifyGridPointer(
  draggedId: string,
  x: number,
  y: number,
  rects: readonly GridTargetRect[],
  order: readonly string[],
  canMerge: (draggedId: string, targetId: string) => boolean,
): GridPointerDecision;
