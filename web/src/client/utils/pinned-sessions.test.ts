import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPinned, pinnedFirst, prunePinned, setPinned } from './pinned-sessions.js';

describe('pinned sessions', () => {
  // The global localStorage mock stores nothing; give these tests a real one.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('puts pinned sessions first and keeps the existing order within each group', () => {
    const rows = ['waiting', 'busy', 'idle-new', 'idle-old'].map((id) => ({ id }));
    const ordered = pinnedFirst(rows, new Set(['idle-old', 'busy']));
    expect(ordered.map((row) => row.id)).toEqual(['busy', 'idle-old', 'waiting', 'idle-new']);
  });

  it('remembers pins and forgets sessions that are gone', () => {
    setPinned('a', true);
    setPinned('b', true);
    setPinned('a', false);
    setPinned('c', true);
    expect([...loadPinned()]).toEqual(['b', 'c']);
    prunePinned(['c', 'other']);
    expect([...loadPinned()]).toEqual(['c']);
  });

  it('survives unreadable storage', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadPinned().size).toBe(0);
  });
});
