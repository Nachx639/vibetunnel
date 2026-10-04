/**
 * Where each pointer went down, to tell a tap from the end of a drag. iOS Safari sends a
 * pointerup, not a pointercancel, when a scroll that started on a button ends, so a button
 * acting on pointerup fired at the end of a scroll.
 */
const downAt = new Map<number, { x: number; y: number }>();
/** Pointer ids grow with every touch: past this many starts, the old ones go. */
const MAX_TRACKED = 32;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (downAt.size >= MAX_TRACKED) downAt.clear();
      downAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
    },
    true
  );
}

/** The pointer moved more than a tap's slop since it went down: a scroll or a drag. */
export function endsADrag(e: PointerEvent, slop = 10): boolean {
  const start = downAt.get(e.pointerId);
  return !!start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop;
}
