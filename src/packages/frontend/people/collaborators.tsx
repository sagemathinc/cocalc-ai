/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import { Button, Space, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon } from "@cocalc/frontend/components";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/people";
import { ConversationList } from "./conversation-list";
import { useCollaboratorProjects } from "./new-conversation";

interface Person {
  account_id: string;
  name: string;
}

// Collaborators come from the existing users store: everyone who shares a
// project with this account.
export function usePeople(): Person[] {
  const user_map = useTypedRedux("users", "user_map");
  const account_id = useTypedRedux("account", "account_id");
  return useMemo(() => {
    const people: Person[] = [];
    user_map?.forEach((user, id) => {
      if (id === account_id || !user?.get?.("collaborator")) return;
      people.push({
        account_id: id,
        name: displayNameFromUserRecord(user?.toJS?.() ?? user) || "Unknown",
      });
    });
    return people.sort((a, b) => a.name.localeCompare(b.name));
  }, [user_map, account_id]);
}

export function CollaboratorList({
  search,
  onSelect,
}: {
  search: string;
  onSelect: (account_id: string) => void;
}) {
  const people = usePeople();
  const shown = people.filter((p) =>
    p.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div style={{ maxWidth: 720 }}>
      {shown.length === 0 ? (
        <Typography.Paragraph type="secondary">
          {people.length
            ? "No matching collaborators."
            : "No collaborators yet."}
        </Typography.Paragraph>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.map((person) => (
            <li key={person.account_id}>
              <button
                type="button"
                onClick={() => onSelect(person.account_id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "6px 8px",
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: UI_COLORS.text,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <Avatar account_id={person.account_id} size={28} />
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PersonDetail({
  account_id,
  conversations,
  onBack,
  onOpenConversation,
  onStartConversation,
}: {
  account_id: string;
  conversations: ListedConversation[];
  onBack: () => void;
  onOpenConversation: (conversation: ListedConversation) => void;
  onStartConversation: () => void;
}) {
  const name = usePeople().find((p) => p.account_id === account_id)?.name;
  const shared = useCollaboratorProjects(account_id);
  const sharedIds = new Set(shared.map((p) => p.project_id));
  // Conversations they have written in, in projects we both belong to.
  const theirs = conversations.filter(
    (c) =>
      sharedIds.has(c.project_id) && c.participant_ids.includes(account_id),
  );
  return (
    <div style={{ maxWidth: 820 }}>
      <Button
        type="text"
        icon={<Icon name="arrow-left" />}
        onClick={onBack}
        style={{ marginBottom: 8 }}
      >
        All collaborators
      </Button>
      <Space align="center" size="middle" style={{ marginBottom: 12 }}>
        <Avatar account_id={account_id} size={48} />
        <Typography.Title level={3} style={{ margin: 0 }}>
          {name ?? "Collaborator"}
        </Typography.Title>
        <Button type="primary" onClick={onStartConversation}>
          Start conversation
        </Button>
      </Space>
      <Typography.Title level={5}>Conversations</Typography.Title>
      <ConversationList
        conversations={theirs}
        onSelect={onOpenConversation}
        emptyText="No conversations with this person yet."
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Shared projects
      </Typography.Title>
      <ul style={{ paddingLeft: 20 }}>
        {shared.map((p) => (
          <li key={p.project_id}>
            <Button
              type="link"
              style={{ padding: 0 }}
              onClick={() =>
                redux.getActions("page").set_active_tab(p.project_id)
              }
            >
              {p.title}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
