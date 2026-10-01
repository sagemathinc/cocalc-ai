/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Tabs } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  DEFAULT_PERSONAL_STATE,
  type Conversation,
  type ListedConversation,
} from "@cocalc/util/people";
import { peopleApi } from "./api";
import { CollaboratorList, PersonDetail, usePeople } from "./collaborators";
import { ConversationList } from "./conversation-list";
import { ConversationView } from "./conversation-view";
import { NewConversationModal } from "./new-conversation";
import { useConversations } from "./use-conversations";
import { useWorkspaceContentNavigation } from "@cocalc/frontend/agents/workspace-content-navigation";

// people_route is "", "conversations/<project_id>/<conversation_id>",
// "collaborators" or "collaborators/<account_id>".
export function parsePeopleRoute(route?: string): {
  tab: "conversations" | "collaborators";
  project_id?: string;
  conversation_id?: string;
  account_id?: string;
} {
  const [head, a, b] = (route ?? "").split("/");
  if (head === "collaborators") return { tab: "collaborators", account_id: a };
  if (head === "conversations" && a && b) {
    return { tab: "conversations", project_id: a, conversation_id: b };
  }
  return { tab: "conversations" };
}

function navigate(route?: string) {
  const page = redux.getActions("page");
  page.setState({ people_route: route || undefined });
  void page.set_active_tab("people", true);
}

function conversationRoute(
  c: Pick<Conversation, "project_id" | "conversation_id">,
) {
  return `conversations/${c.project_id}/${c.conversation_id}`;
}

export function PeoplePage() {
  const active = useTypedRedux("page", "active_top_tab") === "people";
  const route = parsePeopleRoute(useTypedRedux("page", "people_route"));
  const state = useConversations(active);
  const [filter, setFilter] = useState("");
  const [newFor, setNewFor] = useState<{ personId?: string } | null>(null);
  const people = usePeople();
  const navigation = useWorkspaceContentNavigation();

  const selected = useSelectedConversation(
    state.conversations,
    route.project_id,
    route.conversation_id,
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? state.conversations.filter((c) => c.title.toLowerCase().includes(q))
      : state.conversations;
  }, [state.conversations, filter]);

  const conversationsTab = (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 12 }}>
      <div
        style={{
          width: selected ? 320 : "100%",
          maxWidth: selected ? 320 : 820,
          flex: "0 0 auto",
          overflowY: "auto",
          display: selected ? undefined : "block",
        }}
        className={selected ? "people-list-with-detail" : undefined}
      >
        {state.error && <Alert role="alert" type="error" title={state.error} />}
        {state.unavailableBays > 0 && (
          <Alert
            type="warning"
            role="status"
            title="Some conversations could not be loaded right now."
          />
        )}
        {state.loading && state.conversations.length === 0 ? (
          <p role="status">Loading conversations...</p>
        ) : (
          <ConversationList
            conversations={filtered}
            selected={selected?.conversation_id}
            onSelect={(c) => navigate(conversationRoute(c))}
            emptyText={
              filter
                ? "No matching conversations."
                : "No conversations yet. Start one with the people you work with."
            }
          />
        )}
      </div>
      {selected && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <ConversationView
            key={selected.conversation_id}
            conversation={selected}
            onClose={() => navigate("")}
          />
        </div>
      )}
    </div>
  );

  const collaboratorsTab = route.account_id ? (
    <PersonDetail
      account_id={route.account_id}
      conversations={state.conversations}
      onBack={() => navigate("collaborators")}
      onOpenConversation={(c) => navigate(conversationRoute(c))}
      onStartConversation={() => setNewFor({ personId: route.account_id })}
    />
  ) : (
    <CollaboratorList
      search={filter}
      onSelect={(id) => navigate(`collaborators/${id}`)}
    />
  );

  const count =
    route.tab === "conversations"
      ? `${filtered.length} ${filtered.length === 1 ? "conversation" : "conversations"}`
      : `${people.length} ${people.length === 1 ? "collaborator" : "collaborators"}`;

  return (
    <div
      className="smc-vfill"
      style={{
        background: UI_COLORS.page,
        color: UI_COLORS.text,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1440,
          margin: "0 auto",
          padding: "24px 16px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 12,
          }}
        >
          {navigation}
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 600,
              flex: "1 1 auto",
            }}
          >
            People
          </h1>
          <Input
            type="search"
            aria-label={
              route.tab === "conversations"
                ? "Search conversations"
                : "Search collaborators"
            }
            placeholder={
              route.tab === "conversations"
                ? "Search conversations"
                : "Search collaborators"
            }
            prefix={<Icon name="search" />}
            allowClear
            style={{ flex: "0 1 320px", minWidth: 0 }}
            maxLength={256}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button
            type="primary"
            icon={<Icon name="plus" />}
            onClick={() => setNewFor({})}
          >
            New conversation
          </Button>
        </header>
        <div
          role="status"
          aria-atomic="true"
          style={{ color: UI_COLORS.secondary, fontSize: 13, marginBottom: 4 }}
        >
          {count}
          {state.loading && state.conversations.length > 0
            ? " · Refreshing..."
            : ""}
        </div>
        <Tabs
          activeKey={route.tab}
          onChange={(key) => navigate(key === "collaborators" ? key : "")}
          className="smc-vfill"
          style={{ minHeight: 0 }}
          items={[
            {
              key: "conversations",
              label: "Conversations",
              children: conversationsTab,
            },
            {
              key: "collaborators",
              label: "Collaborators",
              children: collaboratorsTab,
            },
          ]}
        />
      </div>
      <NewConversationModal
        open={newFor != null}
        personId={newFor?.personId}
        personName={people.find((p) => p.account_id === newFor?.personId)?.name}
        onClose={() => setNewFor(null)}
        onCreated={(c) => {
          setNewFor(null);
          state.refresh();
          navigate(conversationRoute(c));
        }}
      />
    </div>
  );
}

// The selected conversation normally comes from the list; a direct link to
// one not (yet) in the list is fetched on its own.
function useSelectedConversation(
  conversations: ListedConversation[],
  project_id?: string,
  conversation_id?: string,
): ListedConversation | undefined {
  const inList = conversations.find(
    (c) => c.conversation_id === conversation_id,
  );
  const [fetched, setFetched] = useState<ListedConversation>();
  useEffect(() => {
    setFetched(undefined);
    if (!project_id || !conversation_id || inList) return;
    let canceled = false;
    void peopleApi()
      .getConversation({ project_id, conversation_id })
      .then((c) => {
        if (!canceled && c) setFetched({ ...c, ...DEFAULT_PERSONAL_STATE });
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [project_id, conversation_id, inList != null]);
  return inList ?? fetched;
}
