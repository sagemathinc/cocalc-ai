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

// Primary CTAs within a scope, as {href, name}. Public pages render antd
// <Button type="primary"> as `.ant-btn-primary` (an <a> when it has href).
export function getPrimaryCtas(
  scope: HTMLElement,
): Array<{ href: string | null; name: string }> {
  return Array.from(scope.querySelectorAll(".ant-btn-primary")).map(
    (element) => ({
      href: element.getAttribute("href"),
      name: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    }),
  );
}

// Design guardrail: primary-CTA emphasis stays sane. The Brief sanctions ONE
// main action repeated at most twice (hero + close), so this allows a single
// primary CTA to appear twice — but flags genuine over-emphasis: any primary
// rendered 3+ times, or more than one distinct primary repeated. (Whether a
// given repeated primary is the *right* main action — vs. a secondary action
// over-styled as primary, like the old duplicated "API documentation" CTA — is
// structurally identical to the legitimate pattern and stays a human judgment;
// the copy playbook encodes that rule.)
export function expectPrimaryCtaEmphasisSane(scope: HTMLElement) {
  const counts = new Map<string, number>();
  for (const cta of getPrimaryCtas(scope)) {
    const key = `${cta.name}|${cta.href ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const overRepeated = [...counts.entries()]
    .filter(([, count]) => count > 2)
    .map(([key]) => key);
  const repeated = [...counts.entries()].filter(([, count]) => count >= 2);
  expect(overRepeated).toEqual([]); // no primary CTA appears 3+ times
  expect(repeated.length).toBeLessThanOrEqual(1); // at most one repeated primary
}

// Design guardrail: sane heading structure. No empty headings (any level), and
// no skipped level in the document OUTLINE (h1->h2->h3). h4-h6 are used for
// card / mock-illustration labels in this codebase, not the page outline, so
// they're no-empty-checked but don't gate the level sequence. Going back up a
// level is fine; only a deeper jump of more than one within the outline fails.
export function expectHeadingHierarchy(scope: HTMLElement) {
  let previous = 0;
  for (const heading of scope.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    expect(textLength(heading)).toBeGreaterThan(0);
    const level = Number(heading.tagName[1]);
    if (level <= 3) {
      if (previous > 0) {
        expect(level).toBeLessThanOrEqual(previous + 1);
      }
      previous = level;
    }
  }
}

// Design guardrail: prose density (copy-playbook Principle 6 — design for
// scanning, not reading). Each body <p> stays under maxChars so no section
// becomes a wall of text. Shared so any public page can assert scannability.
export function expectProseDensity(
  scope: HTMLElement,
  { maxChars = 390 }: { maxChars?: number } = {},
) {
  for (const paragraph of scope.querySelectorAll("p")) {
    expect(textLength(paragraph)).toBeLessThanOrEqual(maxChars);
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
