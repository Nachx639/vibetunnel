// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreLocalStorage,
  setupLocalStorageMock,
  waitForCondition,
} from '@/test/utils/component-helpers';
import { MockFitAddon, MockResizeObserver, MockTerminal } from '@/test/utils/terminal-mocks';
import { TERMINAL_FONT_FAMILY, TERMINAL_NERD_FONT_FAMILY } from '../utils/terminal-constants';
import { setTerminalFont } from '../utils/terminal-font';
import { resetTerminalIconFonts, TERMINAL_FONT_NAME } from '../utils/terminal-fonts';

vi.mock('ghostty-web', () => ({
  Ghostty: { load: vi.fn(async () => ({})) },
  // Keeps the options ghostty was created with: fontFamily is what its canvas draws with.
  Terminal: class extends MockTerminal {
    createdWith: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.createdWith = options;
    }
  },
  FitAddon: MockFitAddon,
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

/** document.fonts with loads the test settles itself. */
function installFonts() {
  const target = new EventTarget();
  let settle: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const load = vi.fn(async (_spec: string, _text?: string) => {
    if (!(await ready)) throw new Error('font failed');
    return [{ family: `"${TERMINAL_FONT_NAME}"` } as FontFace];
  });
  // The icon face (U+E000-F8FF less Powerline) as document.fonts lists it; loads when told.
  let iconArrives: () => void = () => {};
  const iconLoaded = new Promise<void>((resolve) => {
    iconArrives = resolve;
  });
  const iconFace = {
    family: `"${TERMINAL_FONT_NAME}"`,
    unicodeRange: 'U+e000-e09f, U+e0d8-f8ff',
    load: vi.fn(async () => {
      await iconLoaded;
      return iconFace;
    }),
  };
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      load,
      forEach: (callback: (face: FontFace) => void) => callback(iconFace as unknown as FontFace),
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    },
  });
  const loadingdone = () => {
    const event = new Event('loadingdone');
    Object.defineProperty(event, 'fontfaces', {
      value: [{ family: `"${TERMINAL_FONT_NAME}"` }],
    });
    target.dispatchEvent(event);
  };
  return { load, settle: (ok: boolean) => settle(ok), loadingdone, iconFace, iconArrives };
}

/** ghostty's canvas renderer and WASM terminal, as far as the font repaint uses them. */
function attachRenderer(term: MockTerminal) {
  const renderer = {
    getMetrics: vi.fn(() => ({ width: 9, height: 18, baseline: 14 })),
    remeasureFont: vi.fn(),
    resize: vi.fn(),
    render: vi.fn(),
  };
  term.renderer = renderer;
  (term as unknown as { wasmTerm: object }).wasmTerm = {};
  return renderer;
}

/** The font family the terminal's container (and so its canvas) is styled with. */
const canvasFont = (element: Terminal) =>
  (terminalOf(element) as unknown as { createdWith: { fontFamily?: string } } | null)?.createdWith
    .fontFamily;
const containerFont = (element: Terminal) =>
  /\.terminal-container \{[^}]*font-family: ([^;]+);/.exec(
    element.querySelector('style')?.textContent ?? ''
  )?.[1];
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const terminalOf = (element: Terminal) =>
  (element as unknown as { terminal: MockTerminal | null }).terminal;
const ready = (element: Terminal) =>
  waitForCondition(() => element.getAttribute('data-ready') === 'true', {
    message: 'terminal not ready',
  });

describe('the terminal and its font', () => {
  let element: Terminal | null = null;

  beforeAll(async () => {
    await import('./terminal');
  });

  beforeEach(() => {
    setupLocalStorageMock();
    resetTerminalIconFonts();
  });

  afterEach(() => {
    element?.remove();
    element = null;
    restoreLocalStorage();
    Reflect.deleteProperty(document, 'fonts');
  });

  describe('with the system monospace font chosen in Settings', () => {
    beforeEach(() => setTerminalFont('system'));

    it('draws with the system font and opens without waiting for any web font', async () => {
      const fonts = installFonts();
      element = await fixture<Terminal>(html`<vibe-terminal session-id="sys-1"></vibe-terminal>`);
      await ready(element);
      expect(fonts.load).not.toHaveBeenCalled();
      expect(canvasFont(element)).toBe(TERMINAL_FONT_FAMILY);
      expect(containerFont(element)).toBe(TERMINAL_FONT_FAMILY);

      element.write('folder \uF07B\r\n');
      expect(fonts.load).not.toHaveBeenCalled();
      expect(fonts.iconFace.load).not.toHaveBeenCalled();
    });
  });

  describe('by default (Hack Nerd Font)', () => {
    it('draws with Hack Nerd Font Mono first', async () => {
      installFonts().settle(true);
      element = await fixture<Terminal>(html`<vibe-terminal session-id="nerd-0"></vibe-terminal>`);
      await ready(element);
      expect(canvasFont(element)).toBe(TERMINAL_NERD_FONT_FAMILY);
      expect(containerFont(element)).toBe(TERMINAL_NERD_FONT_FAMILY);
    });

    it('opens only once the font has loaded: its cells are never measured on a fallback', async () => {
      const fonts = installFonts();
      element = await fixture<Terminal>(html`<vibe-terminal session-id="nerd-1"></vibe-terminal>`);
      await tick();
      expect(fonts.load).toHaveBeenCalledWith(`16px "${TERMINAL_FONT_NAME}"`);
      expect(fonts.load).toHaveBeenCalledWith(`bold 16px "${TERMINAL_FONT_NAME}"`);
      expect(terminalOf(element)).toBeNull();
      expect(element.getAttribute('data-ready')).toBeNull();

      fonts.settle(true);
      await ready(element);
      expect(terminalOf(element)?.open).toHaveBeenCalledOnce();
    });

    it('a font that fails does not keep the terminal from opening', async () => {
      const fonts = installFonts();
      element = await fixture<Terminal>(html`<vibe-terminal session-id="nerd-2"></vibe-terminal>`);
      fonts.settle(false);
      await ready(element);
    });

    it('a snapshot replayed before ghostty opens loads the icon file, and the rows are repainted when it arrives', async () => {
      const fonts = installFonts();
      element = await fixture<Terminal>(html`<vibe-terminal session-id="nerd-4"></vibe-terminal>`);
      // The session's snapshot comes while the terminal still waits for its core font.
      element.write('\x1b[2J\x1b[H\uF07B folder\r\n');
      expect(terminalOf(element)).toBeNull();
      expect(fonts.iconFace.load).toHaveBeenCalledOnce();

      fonts.settle(true);
      await ready(element);
      const renderer = attachRenderer(terminalOf(element) as MockTerminal);
      fonts.iconArrives();
      await waitForCondition(() => renderer.render.mock.calls.some((call) => call[1] === true), {
        message: 'no full repaint after the icon font loaded',
      });
    });

    it('asks for the icon file when output draws an icon, and repaints every row when a file arrives', async () => {
      const fonts = installFonts();
      fonts.settle(true);
      element = await fixture<Terminal>(html`<vibe-terminal session-id="nerd-3"></vibe-terminal>`);
      await ready(element);
      const term = terminalOf(element) as MockTerminal;
      const renderer = attachRenderer(term);

      element.write('\x1b[34m\uF07B\x1b[0m src\r\n');
      expect(fonts.iconFace.load).toHaveBeenCalledOnce();
      // No loadingdone event: the load's own promise brings the repaint.
      fonts.iconArrives();
      await waitForCondition(() => renderer.render.mock.calls.some((call) => call[1] === true), {
        message: 'no full repaint after the icon font loaded',
      });

      renderer.render.mockClear();
      renderer.remeasureFont.mockClear();
      fonts.loadingdone();
      expect(renderer.remeasureFont).toHaveBeenCalledOnce();
      // Same cells: no resize, one full render.
      expect(renderer.resize).not.toHaveBeenCalled();
      expect(renderer.render).toHaveBeenCalledOnce();
      expect(renderer.render.mock.calls[0][1]).toBe(true);

      // The core came after the wait gave up: cells measured anew, canvas resized to them.
      renderer.getMetrics
        .mockReturnValueOnce({ width: 9, height: 18, baseline: 14 })
        .mockReturnValueOnce({ width: 8, height: 17, baseline: 13 });
      renderer.render.mockClear();
      fonts.loadingdone();
      expect(renderer.resize).toHaveBeenCalledWith(term.cols, term.rows);
      expect(renderer.render.mock.calls[0][1]).toBe(true);
    });
  });
});
