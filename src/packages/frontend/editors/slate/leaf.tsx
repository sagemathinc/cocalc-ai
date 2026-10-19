/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { CSSProperties } from "react";
import type { RenderLeafProps } from "./slate-react";
import { startswith } from "@cocalc/util/misc";
import { sanitizeStyleDeclaration } from "@cocalc/frontend/components/sanitize-presentation";

const MARK_STYLES: [string, string][] = [
  ["color:", "color"],
  ["font-family:", "fontFamily"],
  ["font-size:", "fontSize"],
];

// CODE_STYLE -- copied from GitHub
const CODE_STYLE = {
  // Do not reserve extra trailing space after inline code; it looks like a
  // phantom space in prose and makes clicking "after" the code land inside it.
  padding: ".2em 0 .2em .4em",
  margin: 0,
  fontSize: "85%",
  borderRadius: "6px",
  backgroundColor: "var(--cocalc-slate-inline-code-bg, rgba(0, 0, 0, 0.04))",
  color: "var(--cocalc-slate-inline-code-fg, inherit)",
  border: "1px solid var(--cocalc-slate-inline-code-border, transparent)",
} as CSSProperties;

const Leaf: React.FC<RenderLeafProps> = React.memo(
  ({ attributes, children, leaf }) => {
    if (leaf.bold) {
      children = <strong>{children}</strong>;
    }
    if (leaf.italic) {
      children = <em>{children}</em>;
    }
    if (leaf.strikethrough) {
      children = <s>{children}</s>;
    }
    if (leaf.underline) {
      children = <u>{children}</u>;
    }
    if (leaf.sup) {
      children = <sup>{children}</sup>;
    }
    if (leaf.sub) {
      children = <sub>{children}</sub>;
    }
    if (leaf.code) {
      children = <code style={CODE_STYLE}>{children}</code>;
    }
    if (leaf.small) {
      children = <small>{children}</small>;
    }
    if (leaf.tt) {
      children = <span style={{ fontFamily: "monospace" }}>{children}</span>;
    }
    // check for colors, fonts, etc.  The values come from the document
    // (e.g., <span style="color:..."> in Markdown), so they get the same
    // checks as any inline style (no var(), url(), escapes, ...).
    for (const mark in leaf) {
      if (!leaf[mark]) continue; // only if it is true
      for (const [prefix, property] of MARK_STYLES) {
        if (startswith(mark, prefix)) {
          const value = sanitizeStyleDeclaration(
            prefix.slice(0, -1),
            mark.slice(prefix.length),
          );
          if (value != null) {
            children = <span style={{ [property]: value }}>{children}</span>;
          }
        }
      }
    }
    if (leaf.search) {
      // Search highlighting of text nodes.
      // Same color as CodeMirror's default.
      children = <span style={{ backgroundColor: "#ffa" }}>{children}</span>;
    }

    const attrAny = attributes as any;
    let className = attrAny.className ?? "";
    const tokenLeaf = leaf as any;
    if (tokenLeaf.token) {
      const exclude = new Set([
        "text",
        "token",
        "bold",
        "italic",
        "strikethrough",
        "underline",
        "sup",
        "sub",
        "code",
        "small",
        "tt",
        "search",
        "cursor",
      ]);
      const tokenClasses = Object.keys(tokenLeaf)
        .filter((key) => tokenLeaf[key] === true && !exclude.has(key))
        .map((key) => `token ${key}`);
      if (tokenClasses.length > 0) {
        className = [className, ...tokenClasses].filter(Boolean).join(" ");
      }
    }

    return (
      <span {...attributes} className={className}>
        {children}
      </span>
    );
  },
);

export default Leaf;
