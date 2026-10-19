/*

Simple synchronous math formula component, which works fine on the frontend or
the backend (nodejs). We also use a custom component in the frontend app via
FileContext when we need something more sophisticated, e.g., fallback to async
mathjax.

*/

import "katex/dist/katex.min.css";
import { latexMathToHtmlOrError } from "@cocalc/frontend/misc/math-to-html";
import { hasMath, KaTeXHtml, MathSegments, splitMath } from "./segments";

interface Props {
  data: string;
  inMarkdown?: boolean; // ignored, since
}

export default function DefaultMath({ data }: Props) {
  const segments = splitMath(data);
  if (!hasMath(segments)) {
    // no math
    return <>{segments.map(({ value }) => value).join("")}</>;
  }
  return <MathSegments segments={segments} renderMath={renderMath} />;
}

function renderMath(math: string) {
  const { __html, err } = latexMathToHtmlOrError(math);
  if (err) {
    return <span style={{ color: "#ff6666" }}>{err}</span>;
  }
  return <KaTeXHtml __html={__html} />;
}
