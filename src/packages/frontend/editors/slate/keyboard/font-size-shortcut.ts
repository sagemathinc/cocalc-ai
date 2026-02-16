/*
 * Normalize font-size keyboard shortcuts across different keyboard layouts.
 * Some browsers report the shifted character (">") while others report the base
 * key ("."), so we accept both to decide on the font-size delta.
 */

export function getFontSizeDeltaFromKey(
  key: string,
  shiftKey: boolean,
): number | null {
  if (key === ">" || (key === "." && shiftKey)) {
    return 1;
  }
  if (key === "<" || (key === "," && shiftKey)) {
    return -1;
  }
  return null;
}
