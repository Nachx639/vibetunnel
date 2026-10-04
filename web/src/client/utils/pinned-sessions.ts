/**
 * Sessions pinned to the top of the phone list. Per device (localStorage): which sessions
 * matter is a choice made on each phone, not something the server needs to know.
 */

const STORAGE_KEY = 'vt-pinned-sessions';

export function loadPinned(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Not persisted (private mode); still works for this page.
  }
}

/** Pin or unpin a session; returns the new set (a new object, for Lit change detection). */
export function setPinned(sessionId: string, pinned: boolean): Set<string> {
  const ids = loadPinned();
  if (pinned) ids.add(sessionId);
  else ids.delete(sessionId);
  save(ids);
  return new Set(ids);
}

/** Forget sessions that no longer exist so storage doesn't grow forever. */
export function prunePinned(existingIds: Iterable<string>): void {
  const ids = loadPinned();
  const existing = new Set(existingIds);
  let changed = false;
  for (const id of ids) {
    if (!existing.has(id)) {
      ids.delete(id);
      changed = true;
    }
  }
  if (changed) save(ids);
}

/** Pinned sessions first; each group keeps the order it already had. */
export function pinnedFirst<T extends { id: string }>(sessions: T[], pinned: Set<string>): T[] {
  if (!pinned.size) return sessions;
  return [...sessions].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
}
