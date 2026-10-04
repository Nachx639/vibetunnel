import { css } from 'lit';

/**
 * The page's placeholder color (styles.css), for shadow roots, which the page's rules don't
 * reach: fields inside a shadow root used WebKit's grey placeholder, 2.3:1 on the light
 * theme.
 */
export const a11yBaseStyles = css`
  ::placeholder {
    color: var(--color-placeholder, GrayText);
    opacity: 1;
  }
`;
