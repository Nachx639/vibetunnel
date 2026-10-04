/**
 * The top of the iPhone home-screen app under iOS 26+. With the black-translucent status bar and
 * viewport-fit=cover the page paints under the status bar, and iOS draws its scroll-edge effect
 * there: a blur over the web view reaching about 40 pt past the status bar, which frosts the
 * header's title and buttons. It is system chrome: no filter or backdrop on our side causes it.
 *
 * On a phone, the list's header and the session view's header start 40 px below the safe-area
 * inset instead, their opaque background filling the blurred zone, so the blur falls on plain
 * colour (styles.css, html[data-standalone][data-header-clearance]). On by default, with a
 * switch in Settings > Application ("Clear the iPhone's top blur"), per browser in the app
 * preferences. Nothing changes in a browser tab, on tablets and desktops, or where there is no
 * inset (landscape).
 *
 * index.html marks the home-screen app (`data-standalone`); this keeps `data-header-clearance`
 * current, since "phone" depends on the window's size and the switch can change.
 */
import { detectMobile } from './mobile-utils.js';

export const HEADER_CLEARANCE_ATTRIBUTE = 'data-header-clearance';
const PREFERENCES_KEY = 'vibetunnel_app_preferences';
const CHANGED_EVENT = 'vibetunnel-header-clearance-changed';

export function getHeaderClearance(): boolean {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return stored ? JSON.parse(stored).headerClearance !== false : true;
  } catch {
    return true;
  }
}

export function setHeaderClearance(on: boolean): void {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...preferences, headerClearance: on }));
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: on }));
}

/** A phone: a touch device whose shorter side is under 600 px. */
function isPhoneScreen(): boolean {
  return detectMobile() && Math.min(window.innerWidth, window.innerHeight) < 600;
}

/** Keeps html[data-header-clearance] in step with the switch and the screen; returns the stop. */
export function trackHeaderClearance(): () => void {
  const update = (event?: Event) => {
    const on = event instanceof CustomEvent ? event.detail === true : getHeaderClearance();
    document.documentElement.toggleAttribute(HEADER_CLEARANCE_ATTRIBUTE, on && isPhoneScreen());
  };
  update();
  window.addEventListener(CHANGED_EVENT, update);
  window.addEventListener('resize', update);
  return () => {
    window.removeEventListener(CHANGED_EVENT, update);
    window.removeEventListener('resize', update);
    document.documentElement.removeAttribute(HEADER_CLEARANCE_ATTRIBUTE);
  };
}
