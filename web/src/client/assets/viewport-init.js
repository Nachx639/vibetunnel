// Mobile viewport height fix (was inline in index.html: the page's CSP allows no inline
// script, see server/utils/csp.ts).
(() => {
  // Check if mobile device
  // NOTE: This detection logic must match detectMobile() in src/client/utils/mobile-utils.ts
  const isMobile =
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);

  // Handle viewport height - set only once on mobile to prevent resize loops
  function setViewportHeight() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  }

  // Set initial height
  setViewportHeight();

  // On mobile, we only set viewport height once to prevent resize loops
  // On desktop, we still allow dynamic resizing
  if (!isMobile) {
    window.addEventListener('resize', setViewportHeight);
    window.addEventListener('orientationchange', () => {
      setTimeout(setViewportHeight, 100);
    });
  }

  // Force full-screen behavior
  window.addEventListener('load', () => {
    // Scroll to top to hide address bar
    setTimeout(() => {
      window.scrollTo(0, 1);
      setTimeout(() => window.scrollTo(0, 0), 10);
    }, 10);
  });
})();
