/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { MouseEvent } from "react";
import { useEffect, useRef } from "react";
import { Button, Tag } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  COLLABORATION_PAGE_LIMIT,
  collaborationTargetKey,
} from "@cocalc/util/collaborators";
import { DirectoryCollection } from "./directory-collection";
import type { DirectoryCollectionPreferences } from "./directory-collection";
import type { DirectoryApi } from "./workspace-api";

const REASONS = {
  mention: "You were mentioned",
  following: "You follow this conversation",
  participation: "You participated",
};

export function participantSummary(resource: CollaborationResource): string {
  const count = resource.participant_count ?? resource.participant_ids.length;
  const approximate =
    resource.participants_truncated && resource.participant_count == null;
  return `${approximate ? "At least " : ""}${count} ${count === 1 ? "participant" : "participants"}${resource.participants_truncated ? " (partial participant preview)" : ""}`;
}

export function ResourceList({
  items,
  onOpen,
  api,
  preferences,
  compact = false,
  selectedId,
}: {
  items: CollaborationResource[];
  api?: DirectoryApi;
  preferences?: DirectoryCollectionPreferences;
  compact?: boolean;
  selectedId?: string;
  onOpen: (
    resource: CollaborationResource,
    event: MouseEvent<HTMLElement>,
  ) => void;
}) {
  const users = useTypedRedux("users", "user_map");
  const accountId = useTypedRedux("account", "account_id");
  const lookups = useRef({ accountId, requested: new Set<string>() });
  useEffect(() => {
    if (lookups.current.accountId !== accountId)
      lookups.current = { accountId, requested: new Set() };
    const visible = new Set(
      items
        .slice(0, COLLABORATION_PAGE_LIMIT)
        .flatMap((item) =>
          item.kind === "conversation" &&
          item.activity > 0 &&
          item.latest_message_author_id
            ? [item.latest_message_author_id]
            : [],
        ),
    );
    // Keep request bookkeeping bounded to this page, not every visited thread.
    const requested = lookups.current.requested;
    for (const id of requested) if (!visible.has(id)) requested.delete(id);
    for (const id of visible) {
      if (requested.has(id) || displayNameFromUserRecord(users?.get?.(id)))
        continue;
      requested.add(id);
      void redux.getActions("users")?.fetch_non_collaborator(id);
    }
  }, [items, users, accountId]);
  const renderItem = (item: CollaborationResource) => (
    <Button
      type="text"
      className="collaborators-row"
      aria-current={
        collaborationTargetKey(item) === selectedId ? "true" : undefined
      }
      onClick={(event) => onOpen(item, event)}
    >
      <span className="collaborators-row-title">
        {item.personal?.alias ? `@${item.personal.alias} · ` : ""}
        {item.title || `Untitled ${item.kind}`}
      </span>
      <span>
        {item.project_title || "Project"}
        {!compact && ` · ${item.kind}`}
      </span>
      {!compact && item.kind === "conversation" && (
        <span>
          {participantSummary(item)} ·{" "}
          {item.updated_at
            ? new Date(item.updated_at).toLocaleString()
            : "No messages yet"}
        </span>
      )}
      {!compact && item.kind === "conversation" && item.activity > 0 && (
        <span>
          Latest message by{" "}
          {displayNameFromUserRecord(
            users?.get?.(item.latest_message_author_id ?? ""),
          ) || "Unknown author"}
        </span>
      )}
      {!compact && item.kind === "conversation" && item.reason && (
        <span>{REASONS[item.reason]}</span>
      )}
      {item.kind === "conversation" && (
        <span>
          {item.activity > (item.personal?.read_through ?? 0) && (
            <Tag>Unread</Tag>
          )}
          {item.reason === "mention" && <Tag>Mention</Tag>}
          {!compact && item.personal?.following && <Tag>Following</Tag>}
          {item.personal?.muted && <Tag>Muted</Tag>}
        </span>
      )}
    </Button>
  );
  return api ? (
    <DirectoryCollection<CollaborationResource>
      items={items}
      preferences={preferences}
      viewOverride={compact ? "list" : undefined}
      itemStyle={(item) =>
        collaborationTargetKey(item) === selectedId
          ? {
              borderColor: UI_COLORS.link,
              borderLeftWidth: 3,
            }
          : {}
      }
      collection="conversations"
      label="Conversations"
      itemId={collaborationTargetKey}
      itemTitle={(item) => item.title || `Untitled ${item.kind}`}
      isPinned={(item) => !!item.personal?.collected}
      onPin={async (item, collected) => {
        await api.setPersonalState({
          project_id: item.project_id,
          kind: item.kind,
          resource_id: item.resource_id,
          patch: { collected },
        });
      }}
      renderItem={renderItem}
    />
  ) : (
    <ul className="collaborators-list">
      {items.map((item) => (
        <li key={collaborationTargetKey(item)}>{renderItem(item)}</li>
      ))}
    </ul>
  );
}
