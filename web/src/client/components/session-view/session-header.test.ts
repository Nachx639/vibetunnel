// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Session } from '../../../shared/types.js';
import type { SessionHeader } from './session-header.js';

const terminalSocketClientMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => true),
  onConnectionStateChange: vi.fn(() => () => {}),
}));

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: terminalSocketClientMock,
}));

import './session-header.js';

describe('SessionHeader', () => {
  const elements: SessionHeader[] = [];

  afterEach(() => {
    for (const element of elements) {
      element.remove();
    }
    elements.length = 0;
  });

  async function renderHeader(options: {
    isMobile: boolean;
    sessionName?: string;
    showBackButton?: boolean;
    showSidebarToggle?: boolean;
    sidebarCollapsed?: boolean;
    onBack?: () => void;
    onSidebarToggle?: () => void;
  }): Promise<SessionHeader> {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${createMockSession({
          id: 'header-controls',
          name: options.sessionName,
        })}
        .isMobile=${options.isMobile}
        .showBackButton=${options.showBackButton ?? false}
        .showSidebarToggle=${options.showSidebarToggle ?? false}
        .sidebarCollapsed=${options.sidebarCollapsed ?? false}
        .onBack=${options.onBack}
        .onSidebarToggle=${options.onSidebarToggle}
      ></session-header>
    `);
    elements.push(element);
    return element;
  }

  it('renders compact 44px mobile navigation controls and preserves callbacks', async () => {
    const onBack = vi.fn();
    const onSidebarToggle = vi.fn();
    const element = await renderHeader({
      isMobile: true,
      showBackButton: true,
      showSidebarToggle: true,
      sidebarCollapsed: true,
      onBack,
      onSidebarToggle,
    });

    const backButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="session-back-button"]'
    );
    const sidebarButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="session-sidebar-toggle"]'
    );
    const chatButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="chat-mode-toggle-button-compact"]'
    );
    const menuButton = element.querySelector<HTMLButtonElement>(
      'compact-menu button[aria-label="More actions menu"]'
    );

    for (const button of [backButton, sidebarButton, chatButton, menuButton]) {
      expect(button).toBeTruthy();
      expect(button?.classList.contains('w-11')).toBe(true);
      expect(button?.classList.contains('h-11')).toBe(true);
    }

    expect(backButton?.getAttribute('aria-label')).toBe('Back');
    expect(backButton?.textContent?.trim()).toBe('');
    expect(backButton?.querySelector('svg')).toBeTruthy();

    backButton?.click();
    sidebarButton?.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSidebarToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop back label and responsive sizing classes', async () => {
    const element = await renderHeader({ isMobile: false, showBackButton: true });
    const backButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="session-back-button"]'
    );

    expect(backButton?.textContent?.trim()).toBe('Back');
    expect(backButton?.classList.contains('md:w-auto')).toBe(true);
    expect(backButton?.classList.contains('md:h-auto')).toBe(true);
  });

  it('shows an ellipsized title on mobile while keeping secondary details desktop-only', async () => {
    const sessionName =
      'Issue 516 iPhone session title that is intentionally very long to verify truncation';
    const element = await renderHeader({ isMobile: true, sessionName });
    const titleContainer = element.querySelector<HTMLElement>(
      '[data-testid="session-title-container"]'
    );
    const details = element.querySelector<HTMLElement>('[data-testid="session-details"]');
    const inlineEdit = titleContainer?.querySelector('inline-edit') as
      | (HTMLElement & { value: string })
      | null;

    expect(titleContainer).toBeTruthy();
    expect(titleContainer?.classList.contains('hidden')).toBe(false);
    expect(titleContainer?.classList.contains('flex-1')).toBe(true);
    expect(inlineEdit?.value).toBe(sessionName);
    expect(details?.classList.contains('hidden')).toBe(true);
    expect(details?.classList.contains('sm:flex')).toBe(true);
  });
});

describe('SessionHeader on a phone on its side', () => {
  // On a Pro Max in landscape the compact header took two lines (title, folder row) and left
  // the terminal less height.
  const store = new Map<string, string>();
  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  };
  const setPhoneUi = (phoneUi: string) =>
    store.set('vibetunnel_app_preferences', JSON.stringify({ phoneUi }));
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    );
    setPhoneUi('compact');
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.restoreAllMocks();
    setWindow(1024, 768);
  });

  const session = (): Session => ({
    ...createMockSession({
      id: 'landscape',
      name: 'Numbers from 1 to 150 with squares',
      command: ['claude'],
      workingDir: '/home/user/project',
    }),
    gitRepoPath: '/home/user/project',
    gitBranch: 'main',
  });

  const mount = async (isMobile = true) => {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${session()}
        .isMobile=${isMobile}
        .showSidebarToggle=${true}
        .sidebarCollapsed=${true}
      ></session-header>
    `);
    await element.updateComplete;
    return element;
  };

  const oneLine = (element: SessionHeader) =>
    element
      .querySelector('[data-testid="session-header-bar"]')
      ?.classList.contains('session-header-one-line');

  it('is one line: the title with the folder and branch inline, no folder row', async () => {
    setWindow(956, 330);
    const element = await mount();
    expect(oneLine(element)).toBe(true);
    const title = element.querySelector('[data-testid="header-phone-title"]');
    expect(title?.textContent).toContain('Numbers from 1 to 150 with squares');
    expect(element.querySelector('[data-testid="header-inline-where"]')?.textContent?.trim()).toBe(
      'project [main]'
    );
    expect(title?.getAttribute('aria-label')).toContain('project [main]');
    expect(element.querySelector('[data-testid="session-details"]')).toBeNull();
    // The status dot stands in for the folder row, and the controls stay.
    expect(element.querySelector('[data-testid="header-status-dot"]')?.className).not.toContain(
      'sm:hidden'
    );
    expect(element.querySelector('[data-testid="session-sidebar-toggle"]')).not.toBeNull();
    element.remove();
  });

  it('goes back to two lines when the phone is turned upright, and again on its side', async () => {
    setWindow(956, 330);
    const element = await mount();
    expect(oneLine(element)).toBe(true);

    setWindow(440, 830);
    window.dispatchEvent(new Event('resize'));
    await element.updateComplete;
    expect(oneLine(element)).toBe(false);
    expect(element.querySelector('[data-testid="header-inline-where"]')).toBeNull();
    expect(element.querySelector('[data-testid="session-details"]')).not.toBeNull();

    setWindow(956, 330);
    window.dispatchEvent(new Event('orientationchange'));
    await element.updateComplete;
    expect(oneLine(element)).toBe(true);
    element.remove();
  });

  it('an SE on its side is one line too', async () => {
    setWindow(667, 323);
    const element = await mount();
    expect(oneLine(element)).toBe(true);
    element.remove();
  });

  it('classic layout unchanged: two lines and the inline editor on its side', async () => {
    setPhoneUi('classic');
    setWindow(956, 330);
    const element = await mount();
    expect(oneLine(element)).toBe(false);
    expect(element.querySelector('inline-edit')).not.toBeNull();
    expect(element.querySelector('[data-testid="session-details"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="header-status-dot"]')?.className).toContain(
      'sm:hidden'
    );
    element.remove();
  });

  it('a short desktop window keeps the desktop header', async () => {
    setWindow(956, 330);
    const element = await mount(false);
    expect(oneLine(element)).toBe(false);
    expect(element.querySelector('[data-testid="session-details"]')).not.toBeNull();
    element.remove();
  });
});
