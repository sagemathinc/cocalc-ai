/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy } from "react";
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
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import { filename_extension } from "@cocalc/util/misc";
import { buildViewerFileContext } from "./viewer-file-context";

const MarkdownRenderer = lazy(() => import("./renderers/markdown"));
const CodeMirrorRenderer = lazy(() => import("./renderers/codemirror"));
const IpynbRenderer = lazy(() => import("./renderers/ipynb"));
const BoardRenderer = lazy(() => import("./renderers/board"));
const SlidesRenderer = lazy(() => import("./renderers/slides"));
const ChatRenderer = lazy(() => import("./renderers/chat"));

export interface PublicViewerFileContentsProps {
  content?: string;
  path: string;
  rawUrl: string;
  fileContext?: IFileContext;
  fontSize?: number;
  lineNumbers?: boolean;
  style?: CSSProperties;
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
  const resolvedFileContext = buildViewerFileContext({
    path,
    rawUrl,
    fileContext,
  });

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
      <Suspense fallback={<LoadingRenderer />}>
        <CodeMirrorRenderer
          content={content}
          fontSize={fontSize}
          lineNumbers={lineNumbers}
          mode={codemirrorMode(ext)}
        />
      </Suspense>
    );
  }

  if (isMarkdown(ext)) {
    return (
      <Suspense fallback={<LoadingRenderer />}>
        <MarkdownRenderer
          content={content}
          style={style}
          fileContext={resolvedFileContext}
        />
      </Suspense>
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
    return (
      <Suspense fallback={<LoadingRenderer />}>
        <IpynbRenderer
          content={content}
          style={style}
          fileContext={resolvedFileContext}
        />
      </Suspense>
    );
  }

  if (ext === "board") {
    return (
      <Suspense fallback={<LoadingRenderer />}>
        <BoardRenderer content={content} fileContext={resolvedFileContext} />
      </Suspense>
    );
  }

  if (ext === "slides") {
    return (
      <Suspense fallback={<LoadingRenderer />}>
        <SlidesRenderer content={content} fileContext={resolvedFileContext} />
      </Suspense>
    );
  }

  if (ext === "chat" || ext === "sage-chat") {
    return (
      <Suspense fallback={<LoadingRenderer />}>
        <ChatRenderer
          content={content}
          fileContext={resolvedFileContext}
          style={style}
        />
      </Suspense>
    );
  }

  return <pre style={style}>{content}</pre>;
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

function LoadingRenderer(): JSX.Element {
  return <div style={{ color: "#666" }}>Loading renderer...</div>;
}
