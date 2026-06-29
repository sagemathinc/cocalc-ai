/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX, ReactNode } from "react";
import {
  FileContext,
  type IFileContext,
} from "@cocalc/frontend/lib/file-context";

export function withViewerFileContext(
  child: JSX.Element,
  fileContext: IFileContext,
): JSX.Element {
  return (
    <FileContext.Provider value={fileContext}>{child}</FileContext.Provider>
  );
}

export function buildViewerFileContext({
  path,
  rawUrl,
  fileContext,
}: {
  path: string;
  rawUrl: string;
  fileContext?: IFileContext;
}): IFileContext {
  // Public viewer pages are served from the dedicated raw/public origin, so we
  // intentionally render them in the trusted mode instead of re-sanitizing
  // markdown/HTML output. This is what allows notebook HTML output, embedded
  // markdown HTML, etc. to behave like the underlying document expects.
  const defaults: IFileContext = {
    disableExtraButtons: true,
    disableMarkdownCodebar: true,
    noSanitize: true,
  };
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
  if (isUnsafeHref(value)) {
    return undefined;
  }
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
  return resolveUrl(value, rawBaseUrl)?.toString();
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
  if (isUnsafeHref(value)) {
    return (
      <a {...attributes} title={title} style={style}>
        {children}
      </a>
    );
  }
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
  const resolvedRawUrl = resolveUrl(value, rawBaseUrl);
  if (resolvedRawUrl == null) {
    return (
      <a {...attributes} href={href} title={title} style={style}>
        {children}
      </a>
    );
  }
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

function resolveUrl(href: string, base: URL): URL | undefined {
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

function isUnsafeHref(href: string): boolean {
  const value = href.trim().toLowerCase();
  return (
    value.startsWith("javascript:") ||
    value.startsWith("data:") ||
    value.startsWith("vbscript:")
  );
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}
