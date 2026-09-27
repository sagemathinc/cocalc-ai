/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { MouseEvent } from "react";
import { Button, Tag } from "antd";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";

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
}: {
  items: CollaborationResource[];
  onOpen: (
    resource: CollaborationResource,
    event: MouseEvent<HTMLElement>,
  ) => void;
}) {
  return (
    <ul className="collaborators-list">
      {items.map((item) => (
        <li key={collaborationTargetKey(item)}>
          <Button
            type="text"
            className="collaborators-row"
            onClick={(event) => onOpen(item, event)}
          >
            <span className="collaborators-row-title">
              {item.personal?.alias ? `@${item.personal.alias} · ` : ""}
              {item.title || `Untitled ${item.kind}`}
            </span>
            <span>
              {item.project_title || "Project"} · {item.kind}
            </span>
            {item.kind === "conversation" && (
              <span>
                {participantSummary(item)} ·{" "}
                {item.updated_at
                  ? new Date(item.updated_at).toLocaleString()
                  : "No messages yet"}
              </span>
            )}
            {item.kind === "conversation" && item.reason && (
              <span>{REASONS[item.reason]}</span>
            )}
            {item.kind === "conversation" && (
              <span>
                {item.activity > (item.personal?.read_through ?? 0) && (
                  <Tag>Unread</Tag>
                )}
                {item.reason === "mention" && <Tag>Mention</Tag>}
                {item.personal?.following && <Tag>Following</Tag>}
                {item.personal?.muted && <Tag>Muted</Tag>}
              </span>
            )}
          </Button>
        </li>
      ))}
    </ul>
  );
}
