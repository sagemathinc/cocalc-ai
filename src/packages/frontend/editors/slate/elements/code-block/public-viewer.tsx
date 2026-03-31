/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { useState } from "react";
import { Element } from "slate";
import type { RenderElementProps } from "../register";
import { register } from "../register";
import PublicViewerMermaid from "./mermaid-public-viewer";
import { highlightCodeHtml } from "./prism";
import { CodeLineElement } from "./code-like";
import type { JupyterCodeCell } from "../jupyter-code-cell/types";
import type { CodeBlock } from "./types";
import { getCodeBlockLineCount, getCodeBlockText, toCodeLines } from "./utils";

type CodeLikeRenderElementProps = Omit<RenderElementProps, "element"> & {
  element: CodeBlock | JupyterCodeCell;
};

const COLLAPSE_THRESHOLD_LINES = 6;
const COLLAPSE_THRESHOLD_CHARS = 1200;
const COLLAPSED_PREVIEW_MAX_LINES = 6;
const COLLAPSED_PREVIEW_MAX_CHARS = 800;
const COLLAPSED_PREVIEW_MAX_LINE_CHARS = 180;

function truncateCollapsedLine(line: string): string {
  if (line.length <= COLLAPSED_PREVIEW_MAX_LINE_CHARS) return line;
  return `${line.slice(0, COLLAPSED_PREVIEW_MAX_LINE_CHARS - 3)}...`;
}

function getCollapsedPreview(value: string): string {
  const previewLines = value
    .split("\n")
    .slice(0, COLLAPSED_PREVIEW_MAX_LINES)
    .map(truncateCollapsedLine);
  let preview = previewLines.join("\n");
  if (preview.length <= COLLAPSED_PREVIEW_MAX_CHARS) {
    return preview;
  }
  const trimmed = preview.slice(0, COLLAPSED_PREVIEW_MAX_CHARS - 3);
  const newline = trimmed.lastIndexOf("\n");
  if (newline > 0) {
    return `${trimmed.slice(0, newline)}...`;
  }
  return `${trimmed}...`;
}

const StaticElement: React.FC<RenderElementProps> = (props) => {
  const { attributes, element, children } = props;
  if (element.type === "code_line") {
    return (
      <CodeLineElement attributes={attributes}>{children}</CodeLineElement>
    );
  }
  if (element.type != "code_block" && element.type != "jupyter_code_cell") {
    throw Error("bug");
  }
  return <StaticCodeBlockElement {...(props as CodeLikeRenderElementProps)} />;
};

function StaticCodeBlockElement({
  attributes,
  element,
}: CodeLikeRenderElementProps) {
  const value = getCodeBlockText(element as any);
  const [expanded, setExpanded] = useState<boolean>(false);
  const isMermaid = element.info == "mermaid";
  if (isMermaid) {
    return (
      <div {...attributes} style={{ marginBottom: "1em", textIndent: 0 }}>
        <PublicViewerMermaid value={value} />
      </div>
    );
  }

  const lineCount = value.split("\n").length;
  const characterCount = value.length;
  const shouldCollapse =
    lineCount > COLLAPSE_THRESHOLD_LINES ||
    characterCount > COLLAPSE_THRESHOLD_CHARS;
  const collapsedPreview = shouldCollapse ? getCollapsedPreview(value) : value;
  const collapsedPreviewLineCount = collapsedPreview.split("\n").length;
  const hiddenLines = Math.max(0, lineCount - collapsedPreviewLineCount);
  const hiddenChars = Math.max(0, characterCount - collapsedPreview.length);
  const collapseDetail =
    hiddenLines > 0
      ? `${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"} hidden`
      : hiddenChars > 0
        ? `${hiddenChars} ${hiddenChars === 1 ? "character" : "characters"} hidden`
        : "collapsed";
  const isCollapsed = shouldCollapse && !expanded;

  return (
    <div {...attributes} style={{ marginBottom: "1em", textIndent: 0 }}>
      {isCollapsed ? (
        <div
          style={{
            cursor: "default",
            padding: "8px 12px 10px 12px",
            background: "white",
            border: "1px solid #dfdfdf",
            borderRadius: "8px",
          }}
        >
          <pre
            className="cocalc-slate-code-block"
            style={{ margin: 0 }}
            dangerouslySetInnerHTML={{
              __html: highlightCodeHtml(collapsedPreview, element.info),
            }}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded(true);
              }
            }}
            style={{
              marginTop: "6px",
              fontSize: "12px",
              color: "#666",
              cursor: "pointer",
            }}
          >
            {lineCount} lines, {characterCount} characters ({collapseDetail})
          </div>
        </div>
      ) : (
        <pre
          className="cocalc-slate-code-block"
          style={{ margin: 0 }}
          dangerouslySetInnerHTML={{
            __html: highlightCodeHtml(value, element.info),
          }}
        />
      )}
    </div>
  );
}

function toSlate({ token }) {
  let value = token.content;
  if (value[value.length - 1] == "\n") {
    value = value.slice(0, value.length - 1);
  }
  const info = token.info ?? "";
  if (typeof info != "string") {
    throw Error("info must be a string");
  }
  return {
    type: "code_block",
    fence: token.type == "fence",
    info,
    children: toCodeLines(value),
  } as Element;
}

function sizeEstimator({ node, fontSize }): number {
  return getCodeBlockLineCount(node as any) * (fontSize + 2) + 10 + fontSize;
}

register({
  slateType: "code_block",
  markdownType: ["fence", "code_block"],
  StaticElement,
  toSlate,
  sizeEstimator,
});

register({
  slateType: "code_line",
  StaticElement,
  fromSlate: ({ children }) => `${children}\n`,
});
