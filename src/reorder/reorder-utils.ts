export type Move = { ids: string[]; from: number; to: number };

/**
 * Moves `id` one step (or `delta` steps) within `ids`. Returns null when the
 * id is missing or the move would leave the list, so callers can ignore it.
 */
export function moveById(ids: string[], id: string, delta: number): Move | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const to = from + delta;
  if (to < 0 || to >= ids.length || to === from) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return { ids: next, from, to };
}

/** Screen-reader text for a completed move; `to` is a zero-based index. */
export function moveAnnouncement(label: string, to: number, total: number): string {
  return `${label} moved to position ${to + 1} of ${total}.`;
}

/** Alt+ArrowUp / Alt+ArrowDown → -1 / +1, anything else → null. */
export function reorderKeyDelta(event: { key: string; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  return null;
}
