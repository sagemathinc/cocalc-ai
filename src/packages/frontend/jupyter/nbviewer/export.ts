/* Convert from Ipynb to HTML.

We give this a non JSX interface so it can be used from the project, which
doesn't directly know about React.

This is meant to be used from node.js only.  Not from webpack at all.
It is used by the project to convert Jupyter notebooks to html,
which is suitable for download or printing to pdf.

Note that the resulting HTML depends on network access for the CSS
for CodeMirror, KaTeX, and antd.  Thus printing to pdf purely on the
backend is impossible in a project without network access.
*/

import NBViewer from "./nbviewer";
import Notebook from "./notebook";
import { renderToString } from "react-dom/server";
import { createElement, CSSProperties } from "react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import type { CoCalcJupyter } from "@cocalc/jupyter/ipynb/parse";
import {
  PASSIVE_DOCUMENT_CSP,
  escapeHtmlText,
} from "@cocalc/frontend/misc/print-document";

// Markdown images carry max-height:100% (from the static slate image element).
// When Chrome moves such an image to the next printed page, it resolves that
// percentage against the stretched flex row of the cell, reserves too little
// height, and paints the image over the cells that follow. Nothing in a
// printed notebook needs that cap.
export const PRINT_CSS =
  "@media print { .cocalc-slate-render img { max-height: none !important; } }";

interface Options {
  title?: string;
  ipynb?: string;
  cocalcJupyter?: CoCalcJupyter;
  fontSize?: number;
  style?: CSSProperties;
}

export default function exportToHTML({
  passive,
  ...opts
}: Options & {
  // Block all scripts in the resulting document, e.g., for an untrusted
  // notebook, whose HTML outputs are included unsanitized.  (To print in a
  // same-origin popup use writePassiveHtmlDocument, which also removes
  // navigation and frames.)
  passive?: boolean;
}): string {
  const { title, head, body } = exportToHTMLParts(opts);
  return `<html>
<head>
${passive ? PASSIVE_DOCUMENT_CSP : ""}
<title>${escapeHtmlText(title)}</title>
${head}
</head>
<body>
${body}
</body>
`;
}

// The document's title, trusted <head> markup (our stylesheets), and the
// rendered notebook body.
export function exportToHTMLParts({
  title,
  ipynb,
  cocalcJupyter,
  fontSize,
  style,
}: Options): { title: string; head: string; body: string } {
  let notebook;
  if (ipynb != null) {
    if (cocalcJupyter != null) {
      throw Error("exactly one of ipynb or cocalcJupyter must be specified");
    }
    notebook = createElement(NBViewer, {
      key: "x",
      content: ipynb,
      fontSize,
      style,
    });
  } else if (cocalcJupyter != null) {
    notebook = createElement(Notebook, {
      key: "x",
      cocalcJupyter,
      fontSize,
      style,
    });
  } else {
    throw Error("at least one of ipynb or cocalcJupyter must be specified");
  }
  const element = createElement(
    FileContext.Provider,
    {
      value: {
        noSanitize: true,
        is_visible: true,
        disableMarkdownCodebar: true,
        disableExtraButtons: true,
        hasLanguageModel: false,
      },
    },
    [notebook],
  );
  let body = renderToString(element);
  const { codemirror, antd, katex } = getVersions();

  return {
    title: title ?? "",
    head: `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/${codemirror}/codemirror.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${katex}/dist/katex.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/antd@${antd}/dist/antd.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<style>${PRINT_CSS}</style>`,
    body,
  };
}

// TODO regarding antd -- see https://github.com/sagemathinc/cocalc/issues/6305
// Due to a change in architecture, the css for antd beyond version 4.24.16 will
// never be available.
// Thus for now we are just hardcoding version  4.24.16.  This is of course much
// better than being compltely broken, but not ideal.  The CSS we actually use
// for Jupyter notebooks from antd is very minimal, so maybe this won't be a problem.
function getVersions() {
  return {
    antd: "4.24.16", // require("antd").version
    codemirror: require("codemirror/package").version,
    katex: require("katex").version,
  };
}
