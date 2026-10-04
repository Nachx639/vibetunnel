// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, ensureLiveRegion, resetAnnouncerForTests } from './announce';

const region = () => document.querySelector<HTMLElement>('[data-testid="a11y-live-region"]');

describe('announce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncerForTests();
  });

  afterEach(() => {
    resetAnnouncerForTests();
    vi.useRealTimers();
  });

  it('creates one polite live region up front', () => {
    ensureLiveRegion();
    ensureLiveRegion();
    expect(document.querySelectorAll('[data-testid="a11y-live-region"]')).toHaveLength(1);
    expect(region()?.getAttribute('aria-live')).toBe('polite');
    expect(region()?.getAttribute('role')).toBe('status');
  });

  it('says the text without leading emoji', () => {
    announce('✅ Session created');
    vi.advanceTimersByTime(60);
    expect(region()?.textContent).toBe('Session created');
  });

  it('says the same text once within a few seconds, again after', () => {
    announce('Copied');
    vi.advanceTimersByTime(60);
    const live = region();
    if (live) live.textContent = 'marker';
    announce('Copied');
    vi.advanceTimersByTime(60);
    expect(region()?.textContent).toBe('marker');
    vi.advanceTimersByTime(5000);
    announce('Copied');
    vi.advanceTimersByTime(60);
    expect(region()?.textContent).toBe('Copied');
  });

  it('ignores empty text', () => {
    announce('  ');
    expect(region()).toBeNull();
  });
});
