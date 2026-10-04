/**
 * CSS height that fits a textarea's text. scrollHeight already includes the padding, so a
 * content-box field must subtract it (and a border-box one add its borders). The composer is
 * content-box: setting height = scrollHeight would count the padding twice, and the first typed
 * letter would grow the one-line field by an empty extra line. Its own module: the list's ask
 * box uses it too, without the chat view.
 */
export function composerHeightFor(
  scrollHeight: number,
  style: Pick<
    CSSStyleDeclaration,
    'boxSizing' | 'paddingTop' | 'paddingBottom' | 'borderTopWidth' | 'borderBottomWidth'
  >
): number {
  const px = (value: string) => Number.parseFloat(value) || 0;
  if (style.boxSizing === 'border-box') {
    return scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth);
  }
  return Math.max(0, scrollHeight - px(style.paddingTop) - px(style.paddingBottom));
}
