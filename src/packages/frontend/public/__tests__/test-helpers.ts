/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared structural-assertion helpers for the public-site tests.
//
// Goal (issue C1): tests assert STRUCTURE, COUNTS, CONTRACTS, ROUTING, and a
// small set of CANARIES — not exact marketing prose. Routine copy edits should
// require zero test changes, while real regressions (wrong CTA target, missing
// or reordered section, internal-language leakage, broken route, lost visual
// contract) still fail. Hoisted from home/__tests__/visual-quality.test.tsx and
// features/__tests__/app.test.tsx so every public test shares one source of
// truth for helpers, thresholds, and canary regexes.
//
// NOTE: this file is intentionally NOT named *.test.ts so Jest's testMatch does
// not treat it as a suite.

import { within } from "@testing-library/react";

// --- Anti-sprawl thresholds (single source so the same element has one cap) ---
export const HERO_H1_MAX = 70;
export const SECTION_H2_MAX = 72;

// --- Canary regexes -------------------------------------------------------

// Internal/implementation language that must never leak into public copy.
// Each surface combines this floor with its own surface-unique terms via
// combineLeak(), rather than redefining the base terms locally.
export const INTERNAL_IMPLEMENTATION_TERMS =
  /serious\s+technical\s+work|project hosts|backend state|logs stay scoped|RootFS|multi-bay|control plane|postgres|kubernetes|systemd|conat/i;

// Banned/stale repetitive home taglines (incl. the brief's own promise sentence,
// which is internal phrasing and must not appear verbatim in rendered copy).
// UNION of the lines previously guarded in visual-quality.test.tsx and
// home/__tests__/app.test.tsx — do not drop any phrase when editing.
export const STALE_REPETITIVE_HOME_LINES =
  /One workspace for code, notebooks, documents, compute, and AI|Bring technical work back into one context|One workspace for research, courses, and platform teams|Use the tools you already understand, together|Collaborative computing for research, teaching, and teams|Shared project workspaces for research, teaching, and technical teams|shared project space for notebooks, code, documents, terminals|Make computational work easier to share, review, and continue|CoCalc is a shared project workspace for computational work|CoCalc keeps the work in one project/i;

// Dark panel backgrounds — public feature/CTA panels must stay light.
export const DARK_FEATURE_CARD_STYLE =
  /#10213f|#0b1522|#0b1f47|#111827|rgb\(16,\s*33,\s*63\)|rgb\(11,\s*21,\s*34\)|rgb\(11,\s*31,\s*71\)|rgb\(17,\s*24,\s*39\)/i;

// Combine the shared leakage floor with surface-unique terms into one regex.
export function combineLeak(...sources: Array<RegExp | string>): RegExp {
  const source = sources
    .map((s) => (typeof s === "string" ? s : s.source))
    .join("|");
  return new RegExp(source, "i");
}

// --- DOM structural helpers ----------------------------------------------

// Whitespace-normalized visible-text length.
export function textLength(element: Element): number {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

// querySelector-or-fail: assert present and return as HTMLElement.
export function getGrid(container: HTMLElement, selector: string): HTMLElement {
  const grid = container.querySelector(selector);
  expect(grid).not.toBeNull();
  return grid as HTMLElement;
}

// A grid's direct element children (the "cards").
export function getDirectCards(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.children) as HTMLElement[];
}

// Each card's heading text (default <h4>), asserting the heading exists.
export function getCardTitles(
  grid: HTMLElement,
  headingSelector = "h4",
): string[] {
  return getDirectCards(grid).map((card) => {
    const heading = card.querySelector(headingSelector);
    expect(heading).not.toBeNull();
    return heading?.textContent?.trim() ?? "";
  });
}

// Normalized heading texts within a scope (default h2/h3/h4) for
// count/uniqueness/order checks without pinning the prose.
export function getHeadingTexts(
  scope: HTMLElement,
  selector = "h2, h3, h4",
): string[] {
  return Array.from(scope.querySelectorAll(selector))
    .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Assert an element's inline style locks a grid-template-columns value.
export function expectGridTemplate(element: HTMLElement, template: string) {
  expect(element.getAttribute("style") ?? "").toContain(
    `grid-template-columns: ${template};`,
  );
}

// Assert every card's total and title text stay under caller-supplied caps.
export function expectCardsStayCompact(
  grid: HTMLElement,
  { maxCardText, maxTitleText }: { maxCardText: number; maxTitleText: number },
) {
  for (const card of getDirectCards(grid)) {
    expect(textLength(card)).toBeLessThanOrEqual(maxCardText);
    const heading = card.querySelector("h4");
    expect(heading).not.toBeNull();
    expect(textLength(heading as HTMLElement)).toBeLessThanOrEqual(
      maxTitleText,
    );
  }
}

// Concatenated text of all injected <style> tags (for @media / class checks).
export function getInjectedCss(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
}

// The canonical routing+count+order canary: link hrefs in DOM order.
export function expectLinkHrefs(
  scope: HTMLElement,
  expectedHrefs: Array<string | null>,
) {
  const hrefs = within(scope)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual(expectedHrefs);
}

// Stub window.matchMedia so antd/responsive components render under jsdom.
export function installMatchMediaStub() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
}
