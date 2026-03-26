/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { Icon } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

export const MAX_WIDTH = "1000px";

export const POLICIES = {
  trust: { label: "Trust" },
} as const;

function publicHref(href: string): string {
  if (href.includes("://") || href.startsWith("mailto:")) {
    return href;
  }
  if (appBasePath === "/") {
    return href;
  }
  return joinUrlPath(appBasePath, href);
}

export function A(props: Record<string, any>) {
  const { href } = props;
  if (href == null) {
    return <a {...props} />;
  }
  if (href.includes("://") || href.startsWith("mailto:")) {
    return <a {...props} href={href} rel="noopener" target="_blank" />;
  }
  return <a {...props} href={publicHref(href)} />;
}

export function Head(_props: Record<string, unknown>) {
  return null;
}

export function Header(_props: Record<string, unknown>) {
  return null;
}

export function Footer(_props: Record<string, unknown>) {
  return null;
}

export function Customize({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function LayoutRoot({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function LayoutContent({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return <div style={style}>{children}</div>;
}

export const Layout = Object.assign(LayoutRoot, {
  Content: LayoutContent,
});

export function Title({
  children,
  level = 1,
  style,
}: {
  children?: ReactNode;
  level?: 1 | 2 | 3 | 4 | 5;
  style?: CSSProperties;
}) {
  if (level === 1) return <h1 style={style}>{children}</h1>;
  if (level === 2) return <h2 style={style}>{children}</h2>;
  if (level === 3) return <h3 style={style}>{children}</h3>;
  if (level === 4) return <h4 style={style}>{children}</h4>;
  return <h5 style={style}>{children}</h5>;
}

export function Paragraph({
  children,
  strong,
  style,
}: {
  children?: ReactNode;
  strong?: boolean;
  style?: CSSProperties;
}) {
  return <p style={style}>{strong ? <strong>{children}</strong> : children}</p>;
}

export function Text({
  children,
  strong,
}: {
  children?: ReactNode;
  strong?: boolean;
}) {
  return strong ? <strong>{children}</strong> : <span>{children}</span>;
}

export function Image({
  alt,
  height,
  src,
  style,
  width,
}: {
  alt: string;
  height?: number | string;
  src: string | { src: string };
  style?: CSSProperties;
  width?: number | string;
}) {
  const resolvedSrc = typeof src === "string" ? publicHref(src) : src.src;
  return (
    <img
      alt={alt}
      height={height}
      src={resolvedSrc}
      style={{ maxWidth: "100%", ...style }}
      width={width}
    />
  );
}

export { Icon };
