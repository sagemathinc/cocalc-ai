/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Math in widget labels, HTMLMath and outputs, typeset with KaTeX in the frame.

import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";

const DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
];

export function typesetMath(elt: Element): void {
  try {
    renderMathInElement(elt as HTMLElement, {
      delimiters: DELIMITERS,
      throwOnError: false,
      ignoredClasses: ["katex"],
    });
  } catch (err) {
    console.warn("typesetting math failed", err);
  }
}

// Typeset the math in labels and HTMLMath views as they appear or change.
// (Upstream HTMLMath calls MathJax, which isn't here.)
export function typesetWidgetMath(root: Element): () => void {
  let scheduled = false;
  const run = () => {
    scheduled = false;
    for (const elt of Array.from(
      root.querySelectorAll(
        ".widget-label, .widget-htmlmath, .widget-label-basic",
      ),
    )) {
      if (!elt.querySelector(".katex")) typesetMath(elt);
    }
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(run, 0);
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  run();
  return () => observer.disconnect();
}
