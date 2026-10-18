/*
More complicated not-necessarily-synchronous (but actually it is sync) math formula component, which
works fine on the frontend but NOT on a backend with node.js.

This supports rendering using KaTeX.

Right now it is *just* katex, so in fact is synchronous.
*/

import "katex/dist/katex.min.css";
import { useEffect, useRef } from "react";
import $ from "jquery";
import { math_escape, math_unescape } from "@cocalc/util/markdown-utils";
import { remove_math, replace_math } from "@cocalc/util/mathjax-utils";
import { latexMathToHtmlOrError } from "@cocalc/frontend/misc/math-to-html";
import { ensureJqueryPluginsInitialized } from "@cocalc/frontend/jquery-plugins/ensure-init";
import { replace_all } from "@cocalc/util/misc";
import { replaceMathBracketDelims } from "./util";

export interface Props {
  data: string;
  inMarkdown?: boolean;
}

export default function KaTeX({ data, inMarkdown }: Props) {
  const ref = useRef<any>(null);
  data = replaceMathBracketDelims(data);
  const [text, math] = remove_math(math_escape(data));

  useEffect(() => {
    // be no-op when math.length == 0.
    if (ref.current == null) return;
    let active = true;
    void ensureJqueryPluginsInitialized()
      .then(() => {
        if (!active || ref.current == null) return;
        // This path processes mixed text/math nodes that are not already
        // Markdown.  data is text, never HTML: the katex plugin finds the math
        // in the DOM's text nodes.
        ref.current.textContent = data;
        $(ref.current).katex({ preProcess: true });
      })
      .catch(() => {
        if (!active || ref.current == null) return;
        ref.current.textContent = data;
      });
    return () => {
      active = false;
    };
  }, [data]);

  if (math.length == 0) {
    // no math and the input is text, so return as is. Definitely do NOT wrap in a span.
    // See https://github.com/sagemathinc/cocalc/issues/5920
    return <>{data}</>;
  }

  if (inMarkdown) {
    const __html = attemptKatex(text, math);
    if (__html != null) {
      // no error -- using katex is allowed and fully worked.
      return <span dangerouslySetInnerHTML={{ __html }}></span>;
    }
  }

  // didn't end up using katex, so we make a span, which we will fill in via that
  // useEffect above.
  return <span ref={ref}></span>;
}

function attemptKatex(text: string, math: string[]): undefined | string {
  // Try to use KaTeX directly, with no jquery or useEffect doing anything:
  for (let i = 0; i < math.length; i++) {
    const { __html, err } = latexMathToHtmlOrError(math[i]);
    if (!err) {
      math[i] = __html;
    } else {
      math[i] = `<div style="color:red" title="${escapeHtml(
        `${err}`,
      )}">${escapeHtml(math[i])}</div>`;
    }
  }
  // Substitute processed math back in.
  return replace_all(math_unescape(replace_math(text, math)), "\\$", "$");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}
