/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { MouseEvent } from "react";
import { Button } from "antd";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { VirtualCollectionList } from "@cocalc/frontend/components/virtual-collection";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import { DirectoryCollection } from "./directory-collection";
import type { DirectoryCollectionPreferences } from "./directory-collection";
import type { DirectoryApi } from "./workspace-api";
import { ActivityTime } from "./activity-time";

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
  const renderItem = (item: CollaborationResource) => {
    const unread =
      item.kind === "conversation" &&
      item.activity > (item.personal?.read_through ?? 0);
    const preview = item.participant_ids.slice(0, 3);
    const additionalParticipants =
      (item.participant_count ?? item.participant_ids.length) - preview.length;
    return (
      <div
        className="collaborators-conversation-row"
        data-unread={unread || undefined}
      >
        <Button
          type="text"
          className="collaborators-row"
          aria-current={
            collaborationTargetKey(item) === selectedId ? "true" : undefined
          }
          onClick={(event) => onOpen(item, event)}
        >
          <span className="collaborators-conversation-title">
            {unread && (
              <span
                className="collaborators-unread-dot"
                role="img"
                aria-label="Unread"
              />
            )}
            <span className="collaborators-row-title">
              {item.title || `Untitled ${item.kind}`}
            </span>
            {item.personal?.alias && (
              <span className="collaborators-row-alias">
                @{item.personal.alias}
              </span>
            )}
          </span>
          <span className="collaborators-conversation-meta">
            <span className="collaborators-project-label">
              {item.project_title || "Project"}
            </span>
            {item.kind === "conversation" && (
              <span
                className="collaborators-participant-avatars"
                role="img"
                aria-label={participantSummary(item)}
              >
                {preview.map((id) => (
                  <Avatar key={id} account_id={id} size={20} no_tooltip />
                ))}
                {additionalParticipants > 0 && (
                  <span>+{additionalParticipants}</span>
                )}
              </span>
            )}
            {item.kind === "conversation" && item.reason === "mention" && (
              <span role="img" aria-label="You were mentioned">
                @
              </span>
            )}
          </span>
        </Button>
        <ActivityTime
          timestamp={item.activity > 0 ? item.updated_at : undefined}
        />
      </div>
    );
  };
  return api ? (
    <DirectoryCollection<CollaborationResource>
      items={items}
      preferences={preferences}
      viewOverride={compact ? "list" : undefined}
      itemStyle={(item) =>
        collaborationTargetKey(item) === selectedId
          ? {
              boxShadow: `inset 3px 0 ${UI_COLORS.link}`,
              background: UI_COLORS.inset,
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
    <VirtualCollectionList
      className="collaborators-list"
      items={items}
      itemId={collaborationTargetKey}
      renderItem={renderItem}
    />
  );
}
