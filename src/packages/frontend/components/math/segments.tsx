/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Split mixed text and math into segments, and render them as React nodes.

This is the one tokenizer shared by the SSR math component (./ssr.tsx) and the
frontend KaTeX component (./katex.tsx).  Ordinary text is always rendered as
React text nodes, never as HTML, so markup in the text (including entities
that were decoded on the way here) stays text.  The only HTML boundary is the
KaTeX output for each math segment, produced by the renderMath callback.
*/

import { Fragment, type ReactNode } from "react";
import { math_escape, math_unescape } from "@cocalc/util/markdown-utils";
import { remove_math } from "@cocalc/util/mathjax-utils";
import { replace_all } from "@cocalc/util/misc";
import { replaceMathBracketDelims } from "./util";

export type MathSegment =
  | { type: "text"; value: string }
  // value is the math including its delimiters, e.g., "$x$" or "$$x$$".
  | { type: "math"; value: string };

// The placeholder remove_math uses for each extracted formula.
const PLACEHOLDER = /︲︳(\d+)︲︳/;

export function splitMath(data: string): MathSegment[] {
  data = replaceMathBracketDelims(data);
  const [text, math]: [string, string[]] = remove_math(math_escape(data));
  if (math.length == 0) {
    return [{ type: "text", value: data }];
  }
  const segments: MathSegment[] = [];
  // With a capture group, split alternates text, formula index, text, ...
  const parts = text.split(PLACEHOLDER);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 == 0) {
      if (parts[i]) {
        segments.push({ type: "text", value: unescapeText(parts[i]) });
      }
    } else {
      const formula = math[parseInt(parts[i])];
      if (formula != null) {
        segments.push({ type: "math", value: math_unescape(formula) });
      }
    }
  }
  return segments;
}

export function hasMath(segments: MathSegment[]): boolean {
  return segments.some(({ type }) => type == "math");
}

function unescapeText(text: string): string {
  return replace_all(math_unescape(text), "\\$", "$");
}

export function MathSegments({
  segments,
  renderMath,
}: {
  segments: MathSegment[];
  renderMath: (math: string) => ReactNode;
}) {
  return (
    <span>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {segment.type == "text" ? segment.value : renderMath(segment.value)}
        </Fragment>
      ))}
    </span>
  );
}

// Render one formula's KaTeX output.  This is the only place mixed text and
// math becomes HTML: __html must come straight from KaTeX.
export function KaTeXHtml({ __html }: { __html: string }) {
  return <span dangerouslySetInnerHTML={{ __html }}></span>;
}
