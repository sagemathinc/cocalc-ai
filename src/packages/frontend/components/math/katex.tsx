/*
More complicated not-necessarily-synchronous (but actually it is sync) math formula component, which
works fine on the frontend but NOT on a backend with node.js.

This supports rendering using KaTeX.

Right now it is *just* katex, so in fact is synchronous.
*/

import "katex/dist/katex.min.css";
import { useEffect, useRef } from "react";
import $ from "jquery";
import { latexMathToHtmlOrError } from "@cocalc/frontend/misc/math-to-html";
import { ensureJqueryPluginsInitialized } from "@cocalc/frontend/jquery-plugins/ensure-init";
import { hasMath, KaTeXHtml, MathSegments, splitMath } from "./segments";
import { replaceMathBracketDelims } from "./util";

export interface Props {
  data: string;
  inMarkdown?: boolean;
}

export default function KaTeX({ data, inMarkdown }: Props) {
  const ref = useRef<any>(null);
  const segments = splitMath(data);
  const math = hasMath(segments);
  data = replaceMathBracketDelims(data);

  useEffect(() => {
    // be no-op when there is no math.
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

  if (!math) {
    // no math and the input is text, so return as is. Definitely do NOT wrap in a span.
    // See https://github.com/sagemathinc/cocalc/issues/5920
    return <>{data}</>;
  }

  if (inMarkdown) {
    return <MathSegments segments={segments} renderMath={renderMath} />;
  }

  // didn't end up using katex, so we make a span, which we will fill in via that
  // useEffect above.
  return <span ref={ref}></span>;
}

function renderMath(math: string) {
  const { __html, err } = latexMathToHtmlOrError(math);
  if (err) {
    return (
      <div style={{ color: "red" }} title={`${err}`}>
        {math}
      </div>
    );
  }
  return <KaTeXHtml __html={__html} />;
}
