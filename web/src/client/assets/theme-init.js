// Theme before the first paint (was inline in index.html and logs.html: the pages' CSP
// allows no inline script, see server/utils/csp.ts). Runs synchronously from <head>.
(() => {
  // Load saved theme preference or use system preference
  const saved = localStorage.getItem('vibetunnel-theme');
  const theme = saved || 'system';

  // Apply theme immediately
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }

  // Apply immediate background to prevent flash
  const effectiveTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;

  // Set initial background color
  document.documentElement.style.backgroundColor =
    effectiveTheme === 'dark' ? '#0a0a0a' : '#fafafa';
})();
