/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Text } from "slate";
import { register, SlateElement } from "../register";

export interface Paragraph extends SlateElement {
  type: "paragraph";
  blank?: boolean;
}

register({
  slateType: "paragraph",
  markdownType: ["paragraph", "blank_line"],

  toSlate: ({ token, children, state }) => {
    if (token.hidden) {
      // this is how markdown-it happens to encode the
      // idea of a "tight list"; it wraps the items
      // in a "hidden" paragraph.  Weird and annoying,
      // but I can see why, I guess.  Instead, we just
      // set this here, and it propagates up to the
      // enclosing list.  Whichever tightness is first takes
      // precedence.
      state.tight = true;
    }
    const blank = token.type === "blank_line";
    return { type: "paragraph", blank, children } as Paragraph;
  },

  StaticElement: ({ attributes, children, element }) => {
    if (element.type != "paragraph") throw Error("bug");
    const isBlank = element.blank === true;
    const firstChild = element.children?.[0];
    const isEmpty =
      element.children?.length === 1 &&
      Text.isText(firstChild) &&
      firstChild.text === "";
    const baseClassName = (attributes as { className?: string }).className;
    const className = isBlank
      ? [baseClassName, "cocalc-blank-line"].filter(Boolean).join(" ")
      : baseClassName;
    // textIndent: 0 is needed due to task lists -- see slate/elements/list/list-item.tsx
    return (
      <p {...attributes} className={className}>
        <span style={{ textIndent: 0 }}>
          {isBlank && isEmpty ? <br /> : children}
        </span>
      </p>
    );
  },

  sizeEstimator({ node, fontSize }): number {
    const numLines = Math.round(JSON.stringify(node).length / 60);
    return numLines * 1.4 * fontSize + fontSize;
  },
});
