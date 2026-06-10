/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { register, SlateElement } from "../register";
import { useFileContext } from "@cocalc/frontend/lib/file-context";

export interface Heading extends SlateElement {
  type: "heading";
  level: number;
}

register({
  slateType: "heading",

  toSlate: ({ token, children }) => {
    return {
      type: "heading",
      level: parseInt(token.tag?.slice(1) ?? "1"),
      children,
    };
  },

  StaticElement: ({ attributes, children, element }) => {
    if (element.type != "heading") throw Error("bug");

    const { HeadingTagComponent } = useFileContext();
    if (HeadingTagComponent != null) {
      // support custom heading component for static rendering.
      return (
        <HeadingTagComponent {...attributes} level={element.level}>
          {children}
        </HeadingTagComponent>
      );
    }
    const { level } = element;
    const id = toId(toText(element));
    return React.createElement(`h${level}`, { id, ...attributes }, children);
  },
});

function toText(element) {
  if (element.text != null) {
    return element.text;
  }
  if (element.children != null) {
    let s = "";
    for (const child of element.children) {
      s += toText(child);
    }
    return s;
  }
  return "";
}

function toId(text: string): string {
  const id = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "heading";
}
