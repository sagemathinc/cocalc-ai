/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX } from "react";
import {
  codemirrorMode,
  isAudio,
  isCodemirror,
  isHTML,
  isImage,
  isMarkdown,
  isVideo,
} from "@cocalc/frontend/file-extensions";
import Slides from "@cocalc/frontend/frame-editors/slides-editor/share";
import Whiteboard from "@cocalc/frontend/frame-editors/whiteboard-editor/share/index";
import JupyterNotebook from "@cocalc/frontend/jupyter/nbviewer/nbviewer";
import { CodeMirrorStatic } from "@cocalc/frontend/jupyter/codemirror-static";
import {
  FileContext,
  type IFileContext,
} from "@cocalc/frontend/lib/file-context";
import Markdown from "@cocalc/frontend/editors/slate/static-markdown";
import { filename_extension } from "@cocalc/util/misc";

export interface PublicViewerFileContentsProps {
  content?: string;
  path: string;
  rawUrl: string;
  fileContext?: IFileContext;
  fontSize?: number;
  lineNumbers?: boolean;
  style?: CSSProperties;
}

function OpenRawFile({
  rawUrl,
  label,
}: {
  rawUrl: string;
  label: string;
}): JSX.Element {
  return (
    <h2 style={{ textAlign: "center", margin: "32px 0" }}>
      <a href={rawUrl} rel="noreferrer noopener">
        {label}
      </a>
    </h2>
  );
}

function withFileContext(
  child: JSX.Element,
  fileContext?: IFileContext,
): JSX.Element {
  return (
    <FileContext.Provider value={fileContext ?? {}}>
      {child}
    </FileContext.Provider>
  );
}

export default function PublicViewerFileContents({
  content,
  path,
  rawUrl,
  fileContext,
  fontSize,
  lineNumbers = true,
  style,
}: PublicViewerFileContentsProps): JSX.Element {
  const ext = filename_extension(path).toLowerCase();

  if (isImage(ext)) {
    return <img src={rawUrl} style={{ maxWidth: "100%", ...style }} />;
  }

  if (isVideo(ext)) {
    return (
      <video
        controls={true}
        autoPlay={true}
        loop={true}
        style={{ width: "100%", height: "auto", ...style }}
        src={rawUrl}
      />
    );
  }

  if (isAudio(ext)) {
    return (
      <audio
        src={rawUrl}
        autoPlay={true}
        controls={true}
        loop={false}
        style={style}
      />
    );
  }

  if (ext === "pdf") {
    return (
      <embed
        style={{ width: "100%", height: "100vh", ...style }}
        src={rawUrl}
        type="application/pdf"
      />
    );
  }

  if (content == null) {
    return <OpenRawFile rawUrl={rawUrl} label={"Open or Download..."} />;
  }

  if (isCodemirror(ext)) {
    return (
      <CodeMirrorStatic
        value={content}
        font_size={fontSize}
        options={{ lineNumbers, mode: codemirrorMode(ext) }}
      />
    );
  }

  if (isMarkdown(ext)) {
    return withFileContext(
      <Markdown value={content} style={style} />,
      fileContext,
    );
  }

  if (isHTML(ext)) {
    return (
      <iframe
        srcDoc={content}
        style={{ width: "100%", height: "100vh", border: 0, ...style }}
        sandbox="allow-scripts"
      />
    );
  }

  if (ext === "ipynb") {
    return withFileContext(
      <JupyterNotebook content={content} style={style} />,
      fileContext,
    );
  }

  if (ext === "board") {
    return withFileContext(<Whiteboard content={content} />, fileContext);
  }

  if (ext === "slides") {
    return withFileContext(<Slides content={content} />, fileContext);
  }

  return <pre style={style}>{content}</pre>;
}
