/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { GitDiffScrollAnchor } from "./types";

const DRAWER_LINE_SCROLL_PX = 40;

export type GitDrawerScrollCommand =
  | "lineDown"
  | "lineUp"
  | "pageDown"
  | "pageUp"
  | "top";

export function matchGitDrawerScrollCommand(
  evt: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
): GitDrawerScrollCommand | undefined {
  if (evt.altKey || evt.ctrlKey || evt.metaKey) return;
  switch (evt.key) {
    case "ArrowDown":
      return "lineDown";
    case "ArrowUp":
      return "lineUp";
    case "PageDown":
      return "pageDown";
    case "PageUp":
      return "pageUp";
    case "Home":
      return "top";
    case " ":
    case "Spacebar":
      return evt.shiftKey ? "pageUp" : "pageDown";
    default:
      return;
  }
}

export function runGitDrawerScrollCommand(
  node: Pick<HTMLDivElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  command: GitDrawerScrollCommand,
): boolean {
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const pageStep = Math.max(
    DRAWER_LINE_SCROLL_PX,
    Math.round(node.clientHeight * 0.9),
  );
  const current = node.scrollTop;
  let next = current;
  switch (command) {
    case "lineDown":
      next += DRAWER_LINE_SCROLL_PX;
      break;
    case "lineUp":
      next -= DRAWER_LINE_SCROLL_PX;
      break;
    case "pageDown":
      next += pageStep;
      break;
    case "pageUp":
      next -= pageStep;
      break;
    case "top":
      next = 0;
      break;
  }
  const clamped = Math.max(0, Math.min(maxTop, next));
  if (clamped === current) {
    return false;
  }
  node.scrollTop = clamped;
  return true;
}

function getGitDiffAnchorElements(
  node: Pick<HTMLDivElement, "querySelectorAll">,
): HTMLElement[] {
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      "[data-git-anchor-id],[data-git-hunk-hash]",
    ),
  );
}

export function captureGitDiffScrollAnchor(
  node: Pick<
    HTMLDivElement,
    "querySelectorAll" | "getBoundingClientRect" | "clientHeight"
  >,
): GitDiffScrollAnchor | undefined {
  const elements = getGitDiffAnchorElements(node);
  if (!elements.length) return undefined;
  const containerRect = node.getBoundingClientRect();
  const midpoint = containerRect.top + node.clientHeight / 2;
  const visible = elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  });
  const candidates = visible.length ? visible : elements;
  let best: HTMLElement | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top - midpoint);
    if (distance < bestDistance) {
      best = element;
      bestDistance = distance;
    }
  }
  if (!best) return undefined;
  const rect = best.getBoundingClientRect();
  return {
    anchorId: best.dataset.gitAnchorId || undefined,
    hunkHash: best.dataset.gitHunkHash || undefined,
    offsetTop: rect.top - containerRect.top,
  };
}

export function restoreGitDiffScrollAnchor(
  node: Pick<
    HTMLDivElement,
    | "scrollTop"
    | "scrollHeight"
    | "clientHeight"
    | "querySelectorAll"
    | "getBoundingClientRect"
  >,
  anchor?: GitDiffScrollAnchor | null,
): boolean {
  if (!anchor) return false;
  const elements = getGitDiffAnchorElements(node);
  if (!elements.length) return false;
  const target =
    elements.find(
      (element) =>
        !!anchor.anchorId && element.dataset.gitAnchorId === anchor.anchorId,
    ) ??
    elements.find(
      (element) =>
        !!anchor.hunkHash && element.dataset.gitHunkHash === anchor.hunkHash,
    );
  if (!target) return false;
  const containerRect = node.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const rawTop =
    node.scrollTop + (targetRect.top - containerRect.top) - anchor.offsetTop;
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  node.scrollTop = Math.max(0, Math.min(maxTop, rawTop));
  return true;
}

export function scrollGitDrawerElementIntoView(
  node: Pick<
    HTMLDivElement,
    "scrollTop" | "scrollHeight" | "clientHeight" | "getBoundingClientRect"
  >,
  target: Pick<HTMLElement, "getBoundingClientRect">,
  opts: {
    block: "start" | "center";
    offsetTop?: number;
  },
): boolean {
  const containerRect = node.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  let rawTop =
    node.scrollTop +
    (targetRect.top - containerRect.top) -
    Math.max(0, opts.offsetTop ?? 0);
  if (opts.block === "center") {
    rawTop =
      node.scrollTop +
      (targetRect.top - containerRect.top) -
      Math.max(0, (node.clientHeight - targetRect.height) / 2);
  }
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const nextTop = Math.max(0, Math.min(maxTop, rawTop));
  if (Math.abs(nextTop - node.scrollTop) < 1) {
    return false;
  }
  node.scrollTop = nextTop;
  return true;
}
