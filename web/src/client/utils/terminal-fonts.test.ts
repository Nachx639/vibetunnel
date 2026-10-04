import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTerminalIconFonts,
  onTerminalFontsLoaded,
  resetTerminalIconFonts,
  TERMINAL_FONT_NAME,
  TERMINAL_FONT_SPECS,
  type TerminalFontSet,
  waitForTerminalFonts,
} from './terminal-fonts';

/** A FontFaceSet whose loads resolve when the test says. */
function fakeFonts(load: (spec: string, text?: string) => Promise<FontFace[]>) {
  const target = new EventTarget();
  const fonts = {
    load: vi.fn(load),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const loadingdone = (families: string[]) => {
    const event = new Event('loadingdone');
    Object.defineProperty(event, 'fontfaces', { value: families.map((family) => ({ family })) });
    target.dispatchEvent(event);
  };
  return { fonts: fonts as unknown as TerminalFontSet & { load: typeof fonts.load }, loadingdone };
}

const face = { family: TERMINAL_FONT_NAME } as FontFace;

describe('waiting for the terminal font', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves once both core weights are loaded', async () => {
    const { fonts } = fakeFonts(async () => [face]);
    await expect(waitForTerminalFonts(1500, fonts)).resolves.toBe(true);
    expect(fonts.load.mock.calls.map(([spec]) => spec)).toEqual([...TERMINAL_FONT_SPECS]);
  });

  it('gives up after the timeout, so a slow font never keeps the terminal from showing', async () => {
    const { fonts } = fakeFonts(() => new Promise(() => {}));
    let result: boolean | undefined;
    void waitForTerminalFonts(1500, fonts).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  it('a failed or missing font, or no font loading API, does not hold it either', async () => {
    await expect(
      waitForTerminalFonts(1500, fakeFonts(async () => Promise.reject(new Error('404'))).fonts)
    ).resolves.toBe(false);
    await expect(waitForTerminalFonts(1500, fakeFonts(async () => []).fonts)).resolves.toBe(false);
    await expect(waitForTerminalFonts(1500, null)).resolves.toBe(false);
  });
});

/** The six faces styles.css declares, as document.fonts lists them (WebKit serializes lowercase). */
function cssFaces(load: () => Promise<unknown> = async () => undefined) {
  const parts = {
    core: 'U+0-dfff, U+e0a0-e0d7, U+f900-effff',
    pua: 'U+e000-e09f, U+e0d8-f8ff',
    spua: 'U+f0000-10ffff',
  };
  return Object.entries(parts).flatMap(([part, unicodeRange]) =>
    ['400', '700'].map((weight) => ({
      part,
      weight,
      family: `"${TERMINAL_FONT_NAME}"`,
      unicodeRange,
      load: vi.fn(load),
    }))
  );
}

function withFaces(faces: ReturnType<typeof cssFaces>) {
  const { fonts } = fakeFonts(async () => []);
  const other = { family: 'Fira Code', unicodeRange: 'U+0-10ffff', load: vi.fn() };
  Object.assign(fonts, {
    forEach: (callback: (face: FontFace) => void) => {
      for (const face of [other, ...faces]) callback(face as unknown as FontFace);
    },
  });
  return { fonts, other };
}

const loadedParts = (faces: ReturnType<typeof cssFaces>) =>
  faces.filter((face) => face.load.mock.calls.length > 0).map((f) => `${f.part}-${f.weight}`);

describe('the icon files', () => {
  beforeEach(() => resetTerminalIconFonts());

  it('load the face holding the icon, both weights, and nothing for text or Powerline', async () => {
    const faces = cssFaces();
    const { fonts, other } = withFaces(faces);
    const seen = new Set<string>();
    expect(loadTerminalIconFonts('text ─│ powerline \uE0B0\uE0A0', seen, fonts)).toBeNull();
    expect(loadedParts(faces)).toEqual([]);

    await expect(loadTerminalIconFonts('folder \uF07B', seen, fonts)).resolves.toBe(true);
    expect(loadedParts(faces)).toEqual(['pua-400', 'pua-700']);
    expect(other.load).not.toHaveBeenCalled();
    expect(fonts.load).not.toHaveBeenCalled();
    // Already asked for by this terminal: nothing more, and no regex work once both are seen.
    expect(loadTerminalIconFonts('\uE5FF', seen, fonts)).toBeNull();

    await expect(loadTerminalIconFonts('nf-md \u{F0219}', seen, fonts)).resolves.toBe(true);
    expect(loadedParts(faces)).toEqual(['pua-400', 'pua-700', 'spua-400', 'spua-700']);
  });

  it('another terminal is told when the shared load is done, without fetching again', async () => {
    const faces = cssFaces();
    const { fonts } = withFaces(faces);
    await loadTerminalIconFonts('\uF07B', new Set(), fonts);
    await expect(loadTerminalIconFonts('\uF07B', new Set(), fonts)).resolves.toBe(true);
    expect(faces.find((f) => f.part === 'pua')?.load).toHaveBeenCalledOnce();
  });

  it('a file that failed is loaded again by the next icon', async () => {
    const faces = cssFaces(async () => Promise.reject(new Error('offline')));
    const { fonts } = withFaces(faces);
    const seen = new Set<string>();
    await expect(loadTerminalIconFonts('\uF07B', seen, fonts)).resolves.toBe(false);
    expect(seen.size).toBe(0);
    await loadTerminalIconFonts('\uF07B', seen, fonts);
    expect(faces.find((f) => f.part === 'pua')?.load).toHaveBeenCalledTimes(2);
  });

  it('without a listable font set, asks the set to load by text', async () => {
    const { fonts } = fakeFonts(async () => [face]);
    await expect(loadTerminalIconFonts('\u{F0219}', new Set(), fonts)).resolves.toBe(true);
    expect(fonts.load.mock.calls).toEqual(TERMINAL_FONT_SPECS.map((spec) => [spec, '\u{F0219}']));
  });

  it('the terminal hears about its own font arriving, not about other fonts', () => {
    const { fonts, loadingdone } = fakeFonts(async () => []);
    const onLoaded = vi.fn();
    const stop = onTerminalFontsLoaded(onLoaded, fonts);
    loadingdone(['Fira Code']);
    expect(onLoaded).not.toHaveBeenCalled();
    loadingdone([`"${TERMINAL_FONT_NAME}"`]);
    expect(onLoaded).toHaveBeenCalledOnce();
    stop();
    loadingdone([TERMINAL_FONT_NAME]);
    expect(onLoaded).toHaveBeenCalledOnce();
  });
});
