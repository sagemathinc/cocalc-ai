/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export function pageHasFocusedElement(
  doc: Pick<Document, "activeElement" | "body" | "documentElement"> = document,
): boolean {
  const activeElement = doc.activeElement;
  return (
    activeElement != null &&
    activeElement !== doc.body &&
    activeElement !== doc.documentElement
  );
}

export function addExplorerKeyboardListeners({
  target = window,
  handleKeyDown,
  handleKeyUp,
}: {
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleKeyUp: (event: KeyboardEvent) => void;
}): () => void {
  target.addEventListener("keydown", handleKeyDown);
  target.addEventListener("keyup", handleKeyUp);
  return () => {
    target.removeEventListener("keydown", handleKeyDown);
    target.removeEventListener("keyup", handleKeyUp);
  };
}
