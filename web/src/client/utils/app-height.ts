/**
 * The page height of the iPhone home-screen app. With the black-translucent status bar the page
 * paints under the status bar, but innerHeight (and 100dvh, and the visual viewport) come up
 * short by its height: every page ended with a blank band at the bottom. index.html sets
 * --app-height to the screen height at load; the session view keeps it current; the rest of the
 * app puts it back with `resetAppHeight()`.
 */

/**
 * Height an iPhone home-screen web app is missing (the status bar, about 20-62 px). Only iOS
 * standalone in portrait: landscape, iPad, Android and desktop PWAs report real heights, and
 * screen.height there is unrelated to the window (it would push content off-screen).
 */
export function iosStandaloneShortfall(innerHeight: number): number {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone || !/iPhone|iPod/.test(navigator.userAgent)) return 0;
  if (window.innerWidth > window.innerHeight) return 0;
  const gap = window.screen.height - innerHeight;
  return gap > 0 && gap <= 80 ? gap : 0;
}

/**
 * The visible height to give the page: the visual viewport's, plus the status bar only while
 * the window is the visual viewport (no keyboard). With the keyboard up the visible area is the
 * visual viewport itself, and some iOS versions keep innerHeight at its full value then: adding
 * the "shortfall" (screen - innerHeight) would make the page taller than what is visible and put
 * its bottom behind the keyboard's accessory bar.
 */
export function standaloneAppHeight(innerHeight: number, viewportHeight: number): number {
  const windowIsVisualViewport = Math.abs(innerHeight - viewportHeight) < 1;
  return viewportHeight + (windowIsVisualViewport ? iosStandaloneShortfall(innerHeight) : 0);
}

/**
 * The page height outside a session, as index.html sets it: the screen height in an iPhone
 * home-screen app in portrait, else nothing (styles.css: 100dvh, which follows the keyboard by
 * itself). The session view leaves its own value behind when it closes, and one taken with the
 * keyboard up would cut the session list short.
 */
export function resetAppHeight(): void {
  const root = document.documentElement;
  root.style.setProperty('--keyboard-offset', '0px');
  const shortfall = iosStandaloneShortfall(window.innerHeight);
  if (shortfall > 0) {
    root.style.setProperty('--app-height', `${window.screen.height}px`);
  } else {
    root.style.removeProperty('--app-height');
  }
}

/**
 * Puts the page height right again after every rotation, outside a session. index.html sets it
 * once, at load: in the home-screen app in portrait, the screen's height. Turned on its side,
 * the list kept that portrait height (956 pt on a Pro Max, in a 440 pt window): its bottom was
 * off screen. Loaded on its side and turned upright, it missed the status bar's height instead.
 * Inside a session the session view tracks the height itself (lifecycle-event-manager.ts), so
 * this leaves it alone while `inSession()` says so. iOS fires orientationchange before the
 * window has its new size: it is checked again a moment later. Returns the function that stops
 * it.
 */
export function followRotationsOutsideSession(inSession: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const update = () => {
    if (!inSession()) resetAppHeight();
  };
  const rotated = () => {
    update();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      update();
    }, 300);
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', rotated);
  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', rotated);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
