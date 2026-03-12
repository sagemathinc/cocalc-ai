import type { ChatInputControl } from "./input";

export function findChatComposerFocusTarget(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  const selectors = [
    "[data-slate-editor='true']",
    ".CodeMirror textarea",
    "textarea",
    "[contenteditable='true']",
    "input:not([type='hidden'])",
  ];
  for (const selector of selectors) {
    const target = root?.querySelector<HTMLElement>(selector);
    if (target != null) {
      return target;
    }
  }
  return null;
}

function ensureEditableDomSelection(target: HTMLElement): void {
  if (typeof window === "undefined") return;
  if (target.getAttribute("contenteditable") !== "true") return;
  const selection = window.getSelection?.();
  if (selection == null) return;
  const anchorNode = selection.anchorNode;
  if (
    selection.rangeCount > 0 &&
    anchorNode != null &&
    target.contains(anchorNode)
  ) {
    return;
  }
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const firstTextNode = walker.nextNode();
  const range = document.createRange();
  if (firstTextNode != null) {
    range.setStart(firstTextNode, 0);
  } else {
    range.selectNodeContents(target);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function ensureEditableDomSelectionAfterFocus(target: HTMLElement): void {
  ensureEditableDomSelection(target);
  if (typeof window === "undefined") return;
  const rerun = () => {
    if (document.activeElement === target) {
      ensureEditableDomSelection(target);
    }
  };
  window.setTimeout(rerun, 0);
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(rerun);
  }
}

export function refocusChatComposerInput(
  root: ParentNode | null | undefined,
  control?: ChatInputControl | null,
): boolean {
  if (control?.focus?.() !== false) {
    return true;
  }
  const target = findChatComposerFocusTarget(root);
  if (target == null) return false;
  target.focus?.({ preventScroll: true } as FocusOptions);
  ensureEditableDomSelectionAfterFocus(target);
  return true;
}
