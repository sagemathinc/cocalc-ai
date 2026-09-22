import { markdown_it, markdown_to_html } from "./index";
import { parse_markdown } from "../editors/slate/markdown-to-slate/parse-markdown";

const corpus = [
  String.raw`# Result

Inline $x_1^2$ and \(\frac{1}{2}\).

\[
\sum_{i=1}^n i
\]

\begin{equation}x=2\end{equation}`,
  '---\ntitle: Demo\n---\n\n1. Parent\n   - child\n2. Next\n\n- [x] done\n- [ ] next\n\n#topic :smile:\n\n[guide][ref]\n\n[ref]: https://example.com "Guide"',
  "| Item | Count |\n|:---|---:|\n| Tests | 42 |\n\n```python\nprint(42)  \n```\n\nTrailing space \n\n\nLast",
  '<details><summary>More</summary>\n\n**Details**\n\n</details>\n\n<span class="user-mention" account-id="47d0393e-4814-4452-bb6c-35bac4cbd314">@Bella</span>\n\n![plot](plot.png)\n\n<div>raw HTML</div>',
];

test.each(corpus)("preserves CoCalc parser and HTML output: %#", (value) => {
  // JSON conversion captures semantic token data, not prototype methods.
  expect(JSON.parse(JSON.stringify(parse_markdown(value)))).toMatchSnapshot();
  expect(markdown_to_html(value)).toMatchSnapshot();
  expect(markdown_it.options.html).toBe(true);
});
