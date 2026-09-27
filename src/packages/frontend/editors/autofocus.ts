// Initialization must not pull focus out of a dialog opened while an editor
// was loading. Check now, not when the editor's autoFocus prop was rendered.
export function autofocusEditor(
  target: HTMLElement | null | undefined,
  options?: FocusOptions,
): boolean {
  if (target == null || !target.isConnected) return false;
  const dialog = target.ownerDocument.activeElement?.closest(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog',
  );
  if (dialog != null && !dialog.contains(target)) return false;
  target.focus(options);
  return true;
}
