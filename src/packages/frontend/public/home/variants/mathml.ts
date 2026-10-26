/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// MathML for the Home page versions, rendered by the browser itself (no
// script, sharp at any size). React creates these elements in the MathML
// namespace inside <math>, but its JSX types don't list them, so formulas are
// built with createElement: `m("mfrac", null, m("mn", null, "1"), ...)`.

import { createElement, type ReactElement, type ReactNode } from "react";

type MathMLTag =
  | "math"
  | "mrow"
  | "mi"
  | "mn"
  | "mo"
  | "mfrac"
  | "msup"
  | "munderover"
  | "mspace";

export function m(
  tag: MathMLTag,
  attributes: Record<string, string> | null,
  ...children: ReactNode[]
): ReactElement {
  return createElement(tag, attributes, ...children);
}

/** An inline or display formula. */
export function math(
  display: "inline" | "block",
  ...children: ReactNode[]
): ReactElement {
  return m(
    "math",
    display === "block" ? { display: "block" } : null,
    m("mrow", null, ...children),
  );
}

export const mi = (text: string) => m("mi", null, text);
export const mn = (text: string) => m("mn", null, text);
export const mo = (text: string, attributes?: Record<string, string>) =>
  m("mo", attributes ?? null, text);
export const frac = (num: ReactNode, den: ReactNode) =>
  m("mfrac", null, num, den);
export const sup = (base: ReactNode, exp: ReactNode) =>
  m("msup", null, base, exp);
export const space = (width: string) => m("mspace", { width });
/** A function name such as sin, applied to what follows. */
export const fn = (name: string) => [mi(name), mo("⁡"), space("0.17em")];
/** Parentheses that keep their normal size. */
export const paren = (...children: ReactNode[]) => [
  mo("(", { stretchy: "false" }),
  ...children,
  mo(")", { stretchy: "false" }),
];
