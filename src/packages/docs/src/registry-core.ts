/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isPlusDocsEntryId } from "./entries/order";
import { DOCS_CHAPTERS } from "./chapters";
import type {
  DocsAccess,
  DocsAction,
  DocsActionId,
  DocsActionSummary,
  DocsChapter,
  DocsEntry,
  DocsSearchResult,
  DocsVisibility,
} from "./types";

export function createDocsRegistry(entries: readonly DocsEntry[]) {
  const DOCS_ACTION_IDS = new Set<DocsActionId>(
    entries.flatMap((entry) => entry.actions?.map((action) => action.id) ?? []),
  );

  function docsPath(slug?: string): string {
    return slug ? `/docs/${slug.replace(/^\/+/, "")}` : "/docs";
  }

  function docsEntryVisibility(entry: DocsEntry): DocsVisibility {
    return entry.visibility ?? "public";
  }

  function isDocsEntryVisible(
    entry: DocsEntry,
    access: DocsAccess = {},
  ): boolean {
    if (
      entry.requiredFeatures?.some(
        (feature) => !access.features?.includes(feature),
      )
    ) {
      return false;
    }
    if (access.product === "plus" && !isPlusDocsEntryId(entry.id)) {
      return false;
    }
    if (
      entry.siteProfiles != null &&
      access.siteProfile != null &&
      !entry.siteProfiles.includes(access.siteProfile)
    ) {
      return false;
    }
    if (entry.siteProfiles != null && access.siteProfile == null) {
      return false;
    }
    switch (docsEntryVisibility(entry)) {
      case "admin":
        return access.includeAdmin === true;
      case "signed-in":
        return access.includeSignedIn === true || access.includeAdmin === true;
      case "public":
      default:
        return true;
    }
  }

  function listDocsEntries(access: DocsAccess = {}): DocsEntry[] {
    return entries.filter((entry) => isDocsEntryVisible(entry, access));
  }

  function listDocsChapters(access: DocsAccess = {}): DocsChapter[] {
    const categories = new Set(
      listDocsEntries(access).map((entry) => entry.category),
    );
    return DOCS_CHAPTERS.filter((chapter) => categories.has(chapter.category));
  }

  function getDocsChapter(
    category: string,
    access: DocsAccess = {},
  ): DocsChapter | undefined {
    return listDocsChapters(access).find(
      (chapter) => chapter.category === category,
    );
  }

  function getDocsEntry(
    slugOrId: string,
    access: DocsAccess = {},
  ): DocsEntry | undefined {
    const normalized = slugOrId
      .replace(/^\/+/, "")
      .replace(/^docs\//, "")
      .replace(/\/+$/, "");
    return listDocsEntries(access).find(
      (entry) => entry.id === slugOrId || entry.slug === normalized,
    );
  }

  function isDocsActionId(value: unknown): value is DocsActionId {
    return DOCS_ACTION_IDS.has(value as DocsActionId);
  }

  function getDocsAction(
    actionId: string,
    access: DocsAccess = {},
  ): DocsAction | undefined {
    for (const entry of listDocsEntries(access)) {
      const action = entry.actions?.find(
        (candidate) => candidate.id === actionId,
      );
      if (action) return action;
    }
    return undefined;
  }

  function listDocsActions(access: DocsAccess = {}): DocsActionSummary[] {
    return listDocsEntries(access).flatMap((entry) =>
      (entry.actions ?? []).map((action) => ({
        ...action,
        entryId: entry.id,
        entrySlug: entry.slug,
        entryTitle: entry.title,
      })),
    );
  }

  function searchDocsEntries(
    query: string,
    limit = 8,
    access: DocsAccess = {},
  ): DocsSearchResult[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const entries = listDocsEntries(access);

    if (terms.length === 0) {
      return entries.slice(0, limit).map((entry) => ({
        ...entry,
        score: 0,
      }));
    }

    const fieldScore = (
      value: string | undefined,
      weight: number,
      phraseWeight = 0,
    ): number => {
      if (!value) return 0;
      const haystack = value.toLowerCase();
      const termScore = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? weight : 0),
        0,
      );
      return (
        termScore +
        (phraseWeight && haystack.includes(query) ? phraseWeight : 0)
      );
    };

    return entries
      .map((entry) => {
        const actionsText = entry.actions
          ?.map(
            (action) => `${action.id} ${action.label} ${action.description}`,
          )
          .join(" ");
        const score =
          fieldScore(entry.title, 8, 8) +
          fieldScore(entry.summary, 4, 4) +
          fieldScore(actionsText, 3) +
          fieldScore(entry.category, 2) +
          fieldScore(entry.searchKeywords, 2) +
          fieldScore(entry.audiences.join(" "), 1) +
          fieldScore(entry.body, 1);
        return { ...entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  return {
    docsPath,
    docsEntryVisibility,
    isDocsEntryVisible,
    listDocsEntries,
    listDocsChapters,
    getDocsChapter,
    getDocsEntry,
    isDocsActionId,
    getDocsAction,
    listDocsActions,
    searchDocsEntries,
  };
}
