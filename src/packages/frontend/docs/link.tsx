/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  normalizeDocsSlug,
  openAppDocs,
  openAppDocsDrawer,
  openProjectDocs,
} from "./navigation";

interface DocsLinkProps {
  /**
   * Name the link when its children carry no text, e.g. an icon-only link in
   * a narrow toolbar. Declared explicitly because JSX skips excess-property
   * checking for hyphenated attributes, so an unforwarded `aria-label` would
   * be dropped silently rather than failing to compile.
   */
  "aria-label"?: string;
  children: ReactNode;
  className?: string;
  href?: string;
  drawer?: boolean;
  projectId?: string;
  slug: string;
  style?: CSSProperties;
  title?: string;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function docsHref(slug: string, href?: string): string {
  if (href != null) return href;
  const normalized = normalizeDocsSlug(slug);
  return normalized == null
    ? joinUrlPath(appBasePath, "docs")
    : joinUrlPath(appBasePath, "docs", normalized);
}

export function DocsLink({
  "aria-label": ariaLabel,
  children,
  className,
  href,
  drawer = false,
  projectId,
  slug,
  style,
  title,
}: DocsLinkProps) {
  return (
    <a
      aria-label={ariaLabel}
      className={className}
      href={docsHref(slug, href)}
      style={style}
      title={title}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        if (drawer) {
          openAppDocsDrawer(slug, event.currentTarget);
        } else if (projectId != null) {
          openProjectDocs({ projectId, slug });
        } else {
          openAppDocs(slug);
        }
      }}
    >
      {children}
    </a>
  );
}
