/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  getDocsEntry,
  listDocsEntries,
  searchDocsEntries,
  type DocsAccess,
  type DocsEntry,
} from "@cocalc/docs/essential";
import { useDeferredValue, useMemo, useState, type MouseEvent } from "react";
import { Markdown } from "./markdown";
import {
  essentialRouteUrl,
  navigate,
  parseEssentialRoute,
  type UltraliteRoute,
} from "./routes";
import { EmptyState, EssentialLink, InlineAlert, SurfaceHeader } from "./ui";

const DOCS_ACCESS: DocsAccess = {
  includeSignedIn: true,
  siteProfile: "cocalc-ai",
};

export function essentialDocsHref(href: string): string {
  const match = /^\/(?:app-)?docs(?:\/([^?#]*))?([?#].*)?$/.exec(href);
  if (!match) return href;
  return `${essentialRouteUrl({
    kind: "docs",
    slug: match[1] || undefined,
  })}${match[2] ?? ""}`;
}

function DocsEntryLink({ entry }: { entry: DocsEntry }) {
  return (
    <EssentialLink
      className="ul-docs-entry"
      route={{ kind: "docs", slug: entry.slug }}
    >
      <span className="ul-docs-entry-category">{entry.category}</span>
      <strong>{entry.title}</strong>
      <span>{entry.summary}</span>
    </EssentialLink>
  );
}

export default function DocsSurface({
  route,
}: {
  route: Extract<UltraliteRoute, { kind: "docs" }>;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const entries = useMemo(() => listDocsEntries(DOCS_ACCESS), []);
  const selected = route.slug
    ? getDocsEntry(route.slug, DOCS_ACCESS)
    : undefined;
  const results = useMemo(
    () =>
      deferredQuery
        ? searchDocsEntries(deferredQuery, entries.length, DOCS_ACCESS)
        : entries,
    [deferredQuery, entries],
  );
  const showIndex = !selected || !!deferredQuery;

  const followInternalDocsLink = (event: MouseEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor = (event.target as Element | null)?.closest("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const target = parseEssentialRoute({
      hash: url.hash,
      pathname: url.pathname,
      search: url.search,
    });
    if (target?.kind !== "docs") return;
    event.preventDefault();
    navigate(target);
  };

  return (
    <main className="ul-page ul-docs-page" id="main-content">
      <SurfaceHeader
        actions={
          <label className="ul-docs-search">
            <span className="ul-visually-hidden">Search documentation</span>
            <input
              autoComplete="off"
              className="ul-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search docs"
              type="search"
              value={query}
            />
          </label>
        }
        eyebrow="Read-only, lightweight documentation"
        title="Essential Docs"
      />
      {route.slug && !selected ? (
        <InlineAlert kind="warning">
          That documentation page is not available in Essential CoCalc.
        </InlineAlert>
      ) : null}
      {showIndex ? (
        <section aria-label="Documentation pages">
          <p className="ul-docs-intro">
            Concise CoCalc documentation without screenshots, interactive
            actions, bookmarks, notes, or learning controls.
          </p>
          {results.length ? (
            <div className="ul-docs-list">
              {results.map((entry) => (
                <DocsEntryLink entry={entry} key={entry.id} />
              ))}
            </div>
          ) : (
            <EmptyState>No documentation matches this search.</EmptyState>
          )}
        </section>
      ) : (
        <article className="ul-docs-article" onClick={followInternalDocsLink}>
          <EssentialLink className="ul-back-link" route={{ kind: "docs" }}>
            All docs
          </EssentialLink>
          <div className="ul-eyebrow">{selected.category}</div>
          <h2 className="ul-docs-title">{selected.title}</h2>
          <p className="ul-docs-summary">{selected.summary}</p>
          <Markdown
            renderImages={false}
            resolveHref={essentialDocsHref}
            source={selected.body}
          />
        </article>
      )}
    </main>
  );
}
