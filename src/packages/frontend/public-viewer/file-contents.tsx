/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX, ReactNode } from "react";
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
  fileContext: IFileContext,
): JSX.Element {
  return (
    <FileContext.Provider value={fileContext}>{child}</FileContext.Provider>
  );
}

function buildViewerFileContext({
  path,
  rawUrl,
  fileContext,
}: {
  path: string;
  rawUrl: string;
  fileContext?: IFileContext;
}): IFileContext {
  const defaults: IFileContext = { noSanitize: false };
  if (typeof window === "undefined") {
    return { ...defaults, ...fileContext };
  }
  const rawBaseUrl = new URL(rawUrl, window.location.href);
  return {
    ...defaults,
    urlTransform: (href: string, tag?: string) =>
      defaultUrlTransform(rawBaseUrl, href, tag),
    AnchorTagComponent: ({ href, title, children, attributes, style }) => (
      <PublicViewerAnchor
        currentPath={path}
        rawBaseUrl={rawBaseUrl}
        href={href}
        title={title}
        attributes={attributes}
        style={style}
      >
        {children}
      </PublicViewerAnchor>
    ),
    ...fileContext,
  };
}

function defaultUrlTransform(
  rawBaseUrl: URL,
  href: string,
  tag?: string,
): string | undefined {
  const value = `${href ?? ""}`.trim();
  if (
    !value ||
    value.startsWith("data:") ||
    value.startsWith("#") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:")
  ) {
    return undefined;
  }
  if (tag === "a" || value.includes("://")) {
    return undefined;
  }
  if (value.startsWith("/")) {
    return `${rawBaseUrl.origin}${value}`;
  }
  return new URL(value, rawBaseUrl).toString();
}

function PublicViewerAnchor({
  currentPath,
  rawBaseUrl,
  href,
  title,
  children,
  attributes,
  style,
}: {
  currentPath: string;
  rawBaseUrl: URL;
  href?: string;
  title?: string;
  children?: ReactNode;
  attributes?;
  style?: CSSProperties;
}): JSX.Element {
  const value = `${href ?? ""}`.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.includes("://")
  ) {
    const isExternal = value.includes("://");
    return (
      <a
        {...attributes}
        href={href}
        title={title}
        style={style}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noreferrer noopener" : undefined}
      >
        {children}
      </a>
    );
  }
  const resolvedRawUrl = new URL(value, rawBaseUrl);
  const viewerUrl = new URL(window.location.href);
  const resolvedPath = resolveViewerPath(currentPath, value);
  viewerUrl.searchParams.set("source", resolvedRawUrl.toString());
  viewerUrl.searchParams.set("path", resolvedPath);
  viewerUrl.searchParams.set("title", basename(resolvedPath));
  return (
    <a {...attributes} href={viewerUrl.toString()} title={title} style={style}>
      {children}
    </a>
  );
}

function resolveViewerPath(currentPath: string, href: string): string {
  const current = currentPath.startsWith("/") ? currentPath : `/${currentPath}`;
  return new URL(href, `https://public-viewer.invalid${current}`).pathname;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
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
      resolvedFileContext,
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
      resolvedFileContext,
    );
  }

  if (ext === "board") {
    return withFileContext(
      <Whiteboard content={content} />,
      resolvedFileContext,
    );
  }

  if (ext === "slides") {
    return withFileContext(<Slides content={content} />, resolvedFileContext);
  }

  return <pre style={style}>{content}</pre>;
}
