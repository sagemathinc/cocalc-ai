/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register, SlateElement } from "../register";
import { toSlate as toSlateImage } from "../image";
import HTML from "@cocalc/frontend/components/html-ssr";
import { toCodeLines } from "../code-block/utils";

export interface HtmlInline extends SlateElement {
  type: "html_inline";
  isInline: true;
  isVoid: false;
  html: string;
}

export interface HtmlBlock extends SlateElement {
  type: "html_block";
  isInline: false;
  isVoid: false;
  html: string;
}

const StaticElement = ({ attributes, element }) => {
  const html = ((element.html as string) ?? "").trim();
  if (element.type == "html_inline") {
    return (
      <span {...attributes} style={{ display: "inline" }}>
        <HTML inline value={html} />
      </span>
    );
  } else {
    return (
      <div {...attributes}>
        <HTML value={html} />
      </div>
    );
  }
};

register({
  slateType: ["html_inline", "html_block"],

  toSlate: ({ type, token, children }) => {
    // Special case of images (one line, img tag);
    // we use a completely different function.
    if (
      token.content.startsWith("<img ") &&
      token.content.trim().split("\n").length <= 1
    ) {
      return toSlateImage({ type, token, children });
    }
    return {
      type: token.type,
      isVoid: false,
      isInline: token.type == "html_inline",
      html: token.content,
      children:
        token.type == "html_block" ? toCodeLines(token.content) : children,
    };
  },

  StaticElement,
});
