/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useMemo, useState } from "react";
import type { Item } from "@cocalc/frontend/editors/markdown-input/complete";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
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
  conversation: "Human conversations",
};

/** One bounded search, only while a human composer's existing @ menu is open. */
export function useReferenceCompletions({
  search,
  enabled,
  accountId,
  contextProjectId,
  userMap,
}: {
  search?: string;
  enabled: boolean;
  accountId?: string;
  contextProjectId?: string;
  userMap?: any;
}): Item[] {
  const query = search?.trim().toLowerCase().slice(0, 200);
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
    if (query === undefined || !current)
      return [
        {
          value: "collaboration-reference-loading",
          disabled: true,
          group: "References",
          label: <span role="status">Searching accessible references...</span>,
        },
      ];
    if (current.error)
      return [
        {
          value: "collaboration-reference-retry",
          group: "References",
          label: (
            <span role="alert">
              Could not search references. Retry reference search
            </span>
          ),
          onSelect: () => setRevision((n) => n + 1),
        },
      ];
    const page = current.page!;
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const resource of page.items) {
      const identity = collaborationTargetKey(resource);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const creator =
        displayNameFromUserRecord(
          userMap?.get?.(resource.created_by) ??
            userMap?.[resource.created_by ?? ""],
        ) || "Unknown creator";
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
              {resource.kind === "conversation"
                ? "Human conversation"
                : resource.kind === "agent"
                  ? "Agent"
                  : "Artifact"}{" "}
              / {resource.project_title || "Untitled project"} / {creator}
            </span>
          </span>
        ),
      });
    }
    if (page.next)
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
    if (page.coverage !== "complete")
      items.push({
        value: "collaboration-reference-coverage",
        group: "References",
        disabled: true,
        label: (
          <span role="status">
            {page.coverage_message || "Some resources are still being indexed."}
          </span>
        ),
      });
    if (!page.items.length)
      items.push({
        value: "collaboration-reference-empty",
        group: "References",
        disabled: true,
        label: <span role="status">No matching references</span>,
      });
    return items;
  }, [enabled, accountId, query, current, userMap, filter, after]);
}
