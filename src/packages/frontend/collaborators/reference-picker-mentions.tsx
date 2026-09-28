/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Item } from "@cocalc/frontend/editors/markdown-input/complete";
import {
  collaborationReferenceFromResource,
  serializeCollaborationReference,
} from "@cocalc/util/collaboration-references";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationPage,
  CollaborationResource,
} from "@cocalc/util/collaborators";
import { referencePickerApi } from "./reference-picker-api";

const EMPTY: Item[] = [];
const GROUPS = {
  agent: "Agents",
  artifact: "Artifacts",
  conversation: "Conversations",
};

/** Bounded local and global searches, only while the human @ menu is open. */
export function useReferenceCompletions({
  search,
  enabled,
  accountId,
  contextProjectId,
}: {
  search?: string;
  enabled: boolean;
  accountId?: string;
  contextProjectId?: string;
}): Item[] {
  const projects = useTypedRedux("projects", "project_map");
  const query = search?.trim().replace(/^@/, "").toLowerCase().slice(0, 128);
  const filter = JSON.stringify([accountId, contextProjectId, query, enabled]);
  const [cursor, setCursor] = useState<{ filter: string; after: string }>();
  const after = cursor?.filter === filter ? cursor.after : undefined;
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([filter, after, revision]);
  const [state, setState] = useState<{
    key: string;
    page?: CollaborationPage<CollaborationResource>;
    error?: boolean;
  }>();
  const [nearby, setNearby] = useState<{
    filter: string;
    items: CollaborationResource[];
  }>();
  const [exact, setExact] = useState<{
    filter: string;
    resource: CollaborationResource | null;
  }>();

  useEffect(() => {
    if (!enabled || !accountId || !query || query.length > 80) {
      setExact(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      // Exact personal aliases must not disappear behind newer prefix matches.
      void Promise.resolve()
        .then(() => referencePickerApi().resolveChatAlias?.({ alias: query }))
        .then(
          (resource) => {
            if (!cancelled) setExact({ filter, resource: resource ?? null });
          },
          () => {
            if (!cancelled) setExact({ filter, resource: null });
          },
        );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, enabled, accountId, query, revision]);

  useEffect(() => {
    if (!enabled || !accountId || query === undefined || !contextProjectId) {
      setNearby(undefined);
      return;
    }
    let cancelled = false;
    // A small conversation-only query cannot be crowded out by global artifacts
    // and agents. Publish it independently, without waiting on the wider search.
    const timer = setTimeout(
      () => {
        void Promise.resolve()
          .then(() =>
            referencePickerApi().listResources({
              project_id: contextProjectId,
              kind: "conversation",
              search: query,
              scope: "all",
              limit: 25,
            }),
          )
          .then(
            (page) => {
              if (!cancelled) setNearby({ filter, items: page.items });
            },
            () => {
              if (!cancelled) setNearby({ filter, items: [] });
            },
          );
      },
      query ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, enabled, accountId, query, contextProjectId, revision]);

  useEffect(() => {
    if (!enabled || !accountId || query === undefined) {
      setState(undefined);
      setCursor(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          referencePickerApi().listResources({
            search: query,
            scope: "all",
            after,
            limit: 25,
          }),
        )
        .then(
          (page) => {
            if (!cancelled) setState({ key, page });
          },
          () => {
            if (!cancelled) setState({ key, error: true });
          },
        );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, accountId, query, after, key]);

  const current = state?.key === key ? state : undefined;
  // Keep the matcher stable: CodeMirror refreshes its menu when this changes.
  return useMemo(() => {
    if (!enabled || !accountId) return EMPTY;
    if (
      query === undefined ||
      (!current && nearby?.filter !== filter && exact?.filter !== filter)
    )
      return [
        {
          value: "collaboration-reference-loading",
          disabled: true,
          group: "References",
          label: <span role="status">Searching accessible references...</span>,
        },
      ];
    const page = current?.page;
    const seen = new Set<string>();
    const items: Item[] = [];
    const resources = [
      ...(exact?.filter === filter && exact.resource ? [exact.resource] : []),
      ...(nearby?.filter === filter ? nearby.items : []),
      ...(page?.items ?? []),
    ];
    const rank = (resource: CollaborationResource) => {
      const alias = resource.personal?.alias?.toLowerCase();
      return alias && query && alias === query
        ? 0
        : alias && query && alias.startsWith(query)
          ? 1
          : resource.project_id === contextProjectId &&
              resource.kind === "conversation"
            ? 2
            : 3;
    };
    resources.sort((a, b) => rank(a) - rank(b));
    for (const resource of resources) {
      const identity = collaborationTargetKey(resource);
      if (seen.has(identity)) continue;
      seen.add(identity);
      items.push({
        value: serializeCollaborationReference(
          collaborationReferenceFromResource(resource),
        ),
        group: GROUPS[resource.kind],
        // The API has already searched titles/aliases. Do not filter its tokenized
        // matches a second time using CodeMirror's plain substring matching.
        search: query,
        label: (
          <span title="Reference only; does not invoke agents or grant access.">
            <strong>
              {resource.personal?.alias ? `@${resource.personal.alias}: ` : ""}
              {resource.title || resource.kind}
            </strong>
            <span
              style={{
                display: "block",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
                maxWidth: 360,
              }}
            >
              {String(
                resource.project_title ||
                  projects?.getIn?.([resource.project_id, "title"]) ||
                  "Project",
              )}
            </span>
          </span>
        ),
      });
    }
    if (page?.next)
      items.push({
        value: "collaboration-reference-next",
        group: "References",
        label: "More references",
        onSelect: () => setCursor({ filter, after: page.next! }),
      });
    if (after)
      items.push({
        value: "collaboration-reference-first",
        group: "References",
        label: "First reference page",
        onSelect: () => setCursor(undefined),
      });
    if (page && page.coverage !== "complete")
      items.push({
        value: "collaboration-reference-coverage",
        group: "References",
        disabled: true,
        label: <span role="status">Some results may not yet be indexed.</span>,
      });
    if (current?.error)
      items.push({
        value: "collaboration-reference-retry",
        group: "References",
        label: (
          <span role="alert">
            Could not search references. Retry reference search
          </span>
        ),
        onSelect: () => setRevision((n) => n + 1),
      });
    if (!page && !current?.error)
      items.push({
        value: "collaboration-reference-loading",
        disabled: true,
        group: "References",
        label: <span role="status">Searching other projects...</span>,
      });
    if (page && !resources.length)
      items.push({
        value: "collaboration-reference-empty",
        group: "References",
        disabled: true,
        label: <span role="status">No matching references</span>,
      });
    return items;
  }, [
    enabled,
    accountId,
    query,
    current,
    nearby,
    exact,
    projects,
    contextProjectId,
    filter,
    after,
  ]);
}
