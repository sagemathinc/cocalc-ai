/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import MarkdownIt from "markdown-it";
import emojiPlugin from "markdown-it-emoji";
import mathPlugin from "./math-plugin";
import { checkboxPlugin } from "./checkbox-plugin";
import { hashtagPlugin } from "./hashtag-plugin";
import { mentionPlugin } from "./mentions-plugin";
import { blankLinesPlugin } from "./blank-lines-plugin";

export const OPTIONS: MarkdownIt.Options = {
  html: true,
  typographer: false,
  linkify: true,
  breaks: false,
};

// No DOM, React, or editor dependency. HTML tokens are data; consumers decide
// whether/how to display them. Do not treat parser output as sanitized HTML.
export function createMarkdownParser({
  beforePlugins,
  renderBlankLines = false,
}: {
  beforePlugins?: (parser: MarkdownIt) => void;
  renderBlankLines?: boolean;
} = {}): MarkdownIt {
  const parser = new MarkdownIt(OPTIONS);
  if (beforePlugins) parser.use(beforePlugins);
  parser.use(mathPlugin);
  parser.use(emojiPlugin);
  parser.use(checkboxPlugin);
  parser.use(hashtagPlugin);
  parser.use(mentionPlugin);
  parser.use(blankLinesPlugin);
  parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  if (renderBlankLines) {
    parser.renderer.rules.blank_line = (tokens, idx) => {
      const line = tokens[idx].map?.[0];
      const lineAttr = line != null ? ` data-source-line="${line}"` : "";
      return `<p class="cocalc-blank-line"${lineAttr}><br /></p>`;
    };
  }
  return parser;
}

export const markdown_it_slate = createMarkdownParser();
