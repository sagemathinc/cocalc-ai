/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PageSearchBox } from "@cocalc/frontend/search/page-search-box";
import { useListQuery } from "@cocalc/frontend/search/list-query";
import { newConversationRequest } from "@cocalc/frontend/app/sidebar-search-requests";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Select, Tabs } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { PageCreateButton } from "@cocalc/frontend/components/page-create-button";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  DEFAULT_PERSONAL_STATE,
  type Conversation,
  type ListedConversation,
} from "@cocalc/util/people";
import { peopleApi } from "./api";
import { CollaboratorList, PersonDetail, usePeople } from "./collaborators";
import { ConversationCollection } from "./conversation-collection";
import { matchesScope, matchesSearch, SCOPES, type Scope } from "./scope";
import { CollectionViewControl } from "@cocalc/frontend/components/collection";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { ConversationView } from "./conversation-view";
import { NewConversationModal } from "./new-conversation";
import { ScanDialog } from "./scan-dialog";
import { InvitesPanel } from "./invites";
import { useConversations } from "./use-conversations";
import { useWorkspaceContentNavigation } from "@cocalc/frontend/agents/workspace-content-navigation";
import "./people.css";

// people_route is "", "conversations/<project_id>/<conversation_id>",
// "collaborators" or "collaborators/<account_id>".
export function parsePeopleRoute(route?: string): {
  tab: "conversations" | "collaborators" | "invites";
  project_id?: string;
  conversation_id?: string;
  account_id?: string;
} {
  const [head, a, b] = (route ?? "").split("/");
  if (head === "collaborators") return { tab: "collaborators", account_id: a };
  if (head === "invites") return { tab: "invites" };
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
  // The search box (shared with the sidebar's) narrows each tab's list.
  const filter = useListQuery();
  const [newFor, setNewFor] = useState<{ personId?: string } | null>(null);
  const [dialog, setDialog] = useState<"scan">();
  // "+ New Conversation" in the sidebar.
  useEffect(() => newConversationRequest.on(() => setNewFor({})), []);
  const people = usePeople();
  const navigation = useWorkspaceContentNavigation();
  const account_id = useTypedRedux("account", "account_id");
  const project_map = useTypedRedux("projects", "project_map");
  const preferences = useCollectionPreferences("conversations");
  const peoplePreferences = useCollectionPreferences("people");
  const tabPreferences =
    route.tab === "conversations" ? preferences : peoplePreferences;
  const [scope, setScope] = useScope();

  const selected = useSelectedConversation(
    state.conversations,
    route.project_id,
    route.conversation_id,
  );

  const filtered = useMemo(
    () =>
      state.conversations.filter(
        (c) =>
          matchesScope(c, scope, account_id) &&
          matchesSearch(
            c,
            filter,
            project_map?.getIn([c.project_id, "title"]) as string | undefined,
          ),
      ),
    [state.conversations, filter, scope, account_id, project_map],
  );

  const conversationsTab = (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 12 }}>
      <div
        style={{
          width: selected ? 340 : "100%",
          maxWidth: selected ? 340 : 820,
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
          <ConversationCollection
            conversations={filtered}
            preferences={preferences}
            view={selected ? "list" : preferences.value.view}
            compact={selected != null}
            selected={selected?.conversation_id}
            onSelect={(c) => navigate(conversationRoute(c))}
            emptyText={
              filter
                ? "No matching conversations."
                : state.conversations.length > 0
                  ? `No conversations in ${SCOPES[scope]}. Try All accessible.`
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
            conversations={state.conversations}
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
      view={peoplePreferences.value.view}
      preferences={peoplePreferences}
      onSelect={(id) => navigate(`collaborators/${id}`)}
    />
  );

  const count =
    route.tab === "conversations"
      ? `${filtered.length} ${filtered.length === 1 ? "conversation" : "conversations"}`
      : route.tab === "collaborators"
        ? `${people.length} ${people.length === 1 ? "collaborator" : "collaborators"}`
        : "Invitations you sent or received";

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
          // An open conversation gets as much height as possible.
          padding: selected ? "12px 16px" : "24px 16px",
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
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              flex: "1 1 auto",
              minWidth: 0,
            }}
          >
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>People</h1>
            <span
              role="status"
              aria-atomic="true"
              style={{ color: UI_COLORS.secondary, fontSize: 13 }}
            >
              {count}
              {state.loading && state.conversations.length > 0
                ? " · Refreshing..."
                : ""}
            </span>
          </div>
          {!route.account_id && route.tab !== "invites" && (
            <CollectionViewControl
              view={tabPreferences.value.view}
              onChange={tabPreferences.setView}
              label={
                route.tab === "conversations"
                  ? "Conversations"
                  : "Collaborators"
              }
            />
          )}
          <PageSearchBox scope="people" />
          {route.tab === "conversations" && (
            <Button
              icon={<Icon name="sync" />}
              onClick={() => setDialog("scan")}
            >
              Scan
            </Button>
          )}
          <PageCreateButton
            label="New conversation"
            onClick={() => setNewFor({})}
          />
        </header>
        <Tabs
          activeKey={route.tab}
          onChange={(key) => navigate(key === "conversations" ? "" : key)}
          className="people-tabs"
          tabBarExtraContent={
            route.tab === "conversations" ? (
              <Select
                aria-label="Show conversations"
                value={scope}
                onChange={setScope}
                style={{ minWidth: 160 }}
                options={Object.entries(SCOPES).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            ) : undefined
          }
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
            {
              key: "invites",
              label: "Invites",
              children: <InvitesPanel search={filter} />,
            },
          ]}
        />
      </div>
      <ScanDialog
        open={dialog === "scan"}
        conversations={state.conversations}
        onClose={() => setDialog(undefined)}
      />
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

const SCOPE_STORAGE_KEY = "cocalc-people-conversation-scope";

// The chosen filter is a per-browser view preference.
function useScope(): [Scope, (scope: Scope) => void] {
  const [scope, setScopeState] = useState<Scope>(() => {
    try {
      const saved = localStorage.getItem(SCOPE_STORAGE_KEY);
      if (saved && saved in SCOPES) return saved as Scope;
    } catch {}
    return "for-you";
  });
  return [
    scope,
    (value: Scope) => {
      setScopeState(value);
      try {
        localStorage.setItem(SCOPE_STORAGE_KEY, value);
      } catch {}
    },
  ];
}
