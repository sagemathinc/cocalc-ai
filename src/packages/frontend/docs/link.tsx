/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { normalizeDocsSlug, openAppDocs, openProjectDocs } from "./navigation";

interface DocsLinkProps {
  children: ReactNode;
  className?: string;
  href?: string;
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
  children,
  className,
  href,
  projectId,
  slug,
  style,
  title,
}: DocsLinkProps) {
  return (
    <a
      className={className}
      href={docsHref(slug, href)}
      style={style}
      title={title}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        if (projectId != null) {
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
