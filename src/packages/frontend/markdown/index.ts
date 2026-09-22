/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Conversion from Markdown *to* HTML, trying not to horribly mangle math.

We also define and configure our Markdown parsers below, which are used
in other code directly, e.g, in supporting use of the slate editor.
```
*/

export * from "./types";
export * from "./table-of-contents";

import MarkdownIt from "markdown-it";
import {
  OPTIONS,
  createMarkdownParser,
  markdown_it_slate,
} from "@cocalc/util/markdown/parser";
export { OPTIONS, markdown_it_slate };
export { parseHeader } from "@cocalc/util/markdown/header";
const MarkdownItFrontMatter = require("markdown-it-front-matter");
export const markdown_it = createMarkdownParser({ renderBlankLines: true });

/*
Inject line numbers for sync.
 - We track only headings and paragraphs, at any level.
 - TODO Footnotes content causes jumps. Level limit filters it automatically.

See https://github.com/digitalmoksha/markdown-it-inject-linenumbers/blob/master/index.js
*/
function inject_linenumbers_plugin(md) {
  function injectLineNumbers(tokens, idx, options, env, slf) {
    if (tokens[idx].map) {
      const line = tokens[idx].map[0];
      tokens[idx].attrJoin("class", "source-line");
      tokens[idx].attrSet("data-source-line", String(line));
    }
    return slf.renderToken(tokens, idx, options, env, slf);
  }

  md.renderer.rules.paragraph_open = injectLineNumbers;
  md.renderer.rules.heading_open = injectLineNumbers;
  md.renderer.rules.list_item_open = injectLineNumbers;
  md.renderer.rules.table_open = injectLineNumbers;
}
const markdown_it_line_numbers = createMarkdownParser({
  beforePlugins: inject_linenumbers_plugin,
  renderBlankLines: true,
});

/*
Turn the given markdown *string* into an HTML *string*.
We heuristically try to remove and put back the math via
remove_math, so that markdown itself doesn't
mangle it too much before Mathjax/Katex finally see it.
Note that remove_math is NOT perfect, e.g., it messes up

<a href="http://abc" class="foo-$">test $</a>

However, at least it is based on code in Jupyter classical,
so agrees with them, so people are used it it as a "standard".

See https://github.com/sagemathinc/cocalc/issues/2863
for another example where remove_math is annoying.
*/

export interface MD2html {
  html: string;
  frontmatter: string;
}

interface Options {
  line_numbers?: boolean; // if given, embed extra line number info useful for inverse/forward search.
  processMath?: (string) => string; // if given, apply this function to all the math
}

function process(
  markdown_string: string,
  mode: "default" | "frontmatter",
  options?: Options,
): MD2html {
  let text = markdown_string;
  if (typeof text != "string") {
    console.warn(
      "WARNING: called markdown process with non-string input",
      text,
    );
    // this function can get used for rendering markdown errors, and it's better
    // to show something then blow up in our face.
    text = JSON.stringify(text);
  }

  let html: string;
  let frontmatter = "";

  // avoid instantiating a new markdown object for normal md processing
  if (mode == "frontmatter") {
    const md_frontmatter = new MarkdownIt(OPTIONS).use(
      MarkdownItFrontMatter,
      (fm) => {
        frontmatter = fm;
      },
    );
    html = md_frontmatter.render(text);
  } else {
    if (options?.line_numbers) {
      html = markdown_it_line_numbers.render(text);
    } else {
      html = markdown_it.render(text);
    }
  }
  return { html, frontmatter };
}

export function markdown_to_html_frontmatter(s: string): MD2html {
  return process(s, "frontmatter");
}

export function markdown_to_html(s: string, options?: Options): string {
  return process(s, "default", options).html;
}
