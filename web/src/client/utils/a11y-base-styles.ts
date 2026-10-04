import { css } from 'lit';

/**
 * The page's keyboard focus ring and placeholder color (styles.css), for shadow roots, which
 * the page's rules don't reach: buttons inside a shadow root showed no focus ring, and fields
 * used WebKit's grey placeholder, 2.3:1 on the light theme.
 */
export const a11yBaseStyles = css`
  :where(:focus-visible):where(
      :not([tabindex='-1'], input, textarea, select, [contenteditable])
    ) {
    outline: 2px solid var(--color-focus-ring, currentColor);
    outline-offset: 2px;
  }
  ::placeholder {
    color: var(--color-placeholder, GrayText);
    opacity: 1;
  }
`;
