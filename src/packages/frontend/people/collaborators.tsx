/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Space, Tabs, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import {
  Collection,
  type CollectionView,
} from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import type { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type {
  ListedConversation,
  PersonalStatePatch,
  PersonalStateRow,
  SharedWork,
} from "@cocalc/util/people";
import { AliasDialog } from "./alias-dialog";
import { InviteToProjectsModal } from "./invites";
import { VIEW_ONLY_NOTE } from "./agent-access-dialog";
import { conversationEvents, conversationsChanged, peopleApi } from "./api";
import { ConversationCollection } from "./conversation-collection";
import { useCollaboratorProjects } from "./new-conversation";
import { matchesPerson } from "./scope";
export { matchesPerson };

export interface Person {
  account_id: string;
  name: string;
  alias?: string | null;
  pinned: boolean;
  sharedProjects: number;
}

// This account's private state about people (aliases, pins).
export function usePersonStates(): Map<string, PersonalStateRow> {
  const [states, setStates] = useState<Map<string, PersonalStateRow>>(
    new Map(),
  );
  const load = useCallback(() => {
    void peopleApi()
      .listStates({ kind: "person" })
      .then((rows) => setStates(new Map(rows.map((r) => [r.target_id, r]))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    conversationEvents.on("changed", load);
    return () => {
      conversationEvents.off("changed", load);
    };
  }, [load]);
  return states;
}

// Collaborators come from the existing users store: everyone who shares a
// project with this account.
export function usePeople(): Person[] {
  const user_map = useTypedRedux("users", "user_map");
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const states = usePersonStates();
  return useMemo(() => {
    const shared = new Map<string, number>();
    project_map?.forEach((project) => {
      if (project.get("deleted")) return;
      const users = project.get("users");
      if (!users?.has(account_id)) return;
      users.forEach((_, id) => shared.set(id, (shared.get(id) ?? 0) + 1));
    });
    const people: Person[] = [];
    user_map?.forEach((user, id) => {
      if (id === account_id || !user?.get?.("collaborator")) return;
      people.push({
        account_id: id,
        name: displayNameFromUserRecord(user?.toJS?.() ?? user) || "Unknown",
        alias: states.get(id)?.alias ?? null,
        pinned: !!states.get(id)?.pinned,
        sharedProjects: shared.get(id) ?? 0,
      });
    });
    return people.sort((a, b) => a.name.localeCompare(b.name));
  }, [user_map, project_map, account_id, states]);
}

async function setPersonState(account_id: string, patch: PersonalStatePatch) {
  await peopleApi().setState({ kind: "person", target_id: account_id, patch });
  conversationsChanged();
}

type Preferences = ReturnType<typeof useCollectionPreferences>;

export function CollaboratorList({
  search,
  view,
  preferences,
  onSelect,
}: {
  search: string;
  view: CollectionView;
  preferences: Preferences;
  onSelect: (account_id: string) => void;
}) {
  const people = usePeople();
  const [aliasFor, setAliasFor] = useState<Person>();
  const [error, setError] = useState("");
  const shown = people.filter((p) => matchesPerson(p, search));
  if (shown.length === 0) {
    return (
      <Typography.Paragraph type="secondary">
        {people.length ? "No matching collaborators." : "No collaborators yet."}
      </Typography.Paragraph>
    );
  }
  const order = preferences.value.order;
  const pinnedIds = shown.filter((p) => p.pinned).map((p) => p.account_id);
  const fullOrder = [
    ...order,
    ...pinnedIds.filter((id) => !order.includes(id)),
  ];
  const update = (p: Person, patch: PersonalStatePatch) =>
    setPersonState(p.account_id, patch).catch((err) => setError(`${err}`));
  return (
    <div
      style={
        {
          "--collection-grid-min-width": "240px",
          "--collection-heading-size": "16px",
        } as React.CSSProperties
      }
    >
      {error && <Alert role="alert" type="error" title={error} />}
      <Collection<Person>
        items={shown}
        itemId={(p) => p.account_id}
        itemTitle={(p) => p.name}
        pins={fullOrder.filter((id) => pinnedIds.includes(id))}
        view={view}
        otherTitle="Collaborators"
        onPin={(p, pinned) => {
          if (pinned) {
            preferences.setOrder([
              ...fullOrder.filter((id) => id !== p.account_id),
              p.account_id,
            ]);
          }
          void update(p, { pinned });
        }}
        onMove={(visible, id, index) =>
          preferences.setOrder(
            moveVisibleCollectionPin(fullOrder, visible, id, index),
          )
        }
        renderItem={(p, controls) => (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: view === "grid" ? 12 : "0 8px 0 12px",
              minHeight: view === "grid" ? 76 : 48,
              boxSizing: "border-box",
              border: `1px solid ${UI_COLORS.border}`,
              borderRadius: view === "grid" ? 8 : 0,
              marginTop: view === "grid" ? 0 : -1,
              background: UI_COLORS.surface,
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(p.account_id)}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 10,
                border: "none",
                background: "transparent",
                color: UI_COLORS.text,
                textAlign: "left",
                cursor: "pointer",
                padding: 0,
                font: "inherit",
              }}
            >
              <Avatar account_id={p.account_id} size={32} no_tooltip />
              <span style={{ minWidth: 0 }}>
                {/* Names may wrap to two lines: the pin and menu leave too
                    little width for one line of a full name. */}
                <span
                  title={p.name}
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 2,
                    fontWeight: 500,
                    overflow: "hidden",
                    overflowWrap: "anywhere",
                  }}
                >
                  {p.name}
                  {p.alias && (
                    <span style={{ color: UI_COLORS.link, marginLeft: 6 }}>
                      @{p.alias}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    display: "block",
                    color: UI_COLORS.secondary,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.sharedProjects}{" "}
                  {p.sharedProjects === 1
                    ? "shared project"
                    : "shared projects"}
                </span>
              </span>
            </button>
            {controls.dragHandle && (
              <span style={{ width: 28, display: "inline-flex" }}>
                {controls.dragHandle}
              </span>
            )}
            {controls.pinButton}
            {controls.menu(
              [
                {
                  key: "alias",
                  label: p.alias ? `Alias @${p.alias}...` : "Personal alias...",
                  onClick: () => setAliasFor(p),
                },
              ],
              `Options for ${p.name}`,
            )}
          </div>
        )}
      />
      <AliasDialog
        open={aliasFor != null}
        title={aliasFor?.name ?? ""}
        alias={aliasFor?.alias}
        urlKind="people"
        onClose={() => setAliasFor(undefined)}
        onSave={async (alias) => {
          if (aliasFor) await setPersonState(aliasFor.account_id, { alias });
        }}
      />
    </div>
  );
}

function useSharedWork(person_id: string) {
  const [work, setWork] = useState<SharedWork & { unavailable_bays: number }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    setWork(undefined);
    setError("");
    void peopleApi()
      .listSharedWork({ person_id })
      .then((result) => {
        if (!canceled) setWork(result);
      })
      .catch((err) => {
        if (!canceled) setError(`${err}`);
      });
    return () => {
      canceled = true;
    };
  }, [person_id]);
  return { work, error };
}

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  minHeight: 44,
  padding: "0 12px",
  border: `1px solid ${UI_COLORS.border}`,
  marginTop: -1,
  background: UI_COLORS.surface,
  color: UI_COLORS.text,
  textAlign: "left",
  cursor: "pointer",
  font: "inherit",
};

function Cell({
  children,
  grow = 1,
  secondary,
}: {
  children: React.ReactNode;
  grow?: number;
  secondary?: boolean;
}) {
  return (
    <span
      style={{
        flex: grow,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: secondary ? UI_COLORS.secondary : undefined,
        fontSize: secondary ? 13 : undefined,
      }}
    >
      {children}
    </span>
  );
}

// "Drew" from "Drew Sutherland", for short button labels.
function firstName(name?: string): string {
  const first = `${name ?? ""}`.trim().split(/\s+/)[0];
  return first || "them";
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
  const person = usePeople().find((p) => p.account_id === account_id);
  const shared = useCollaboratorProjects(account_id);
  const project_map = useTypedRedux("projects", "project_map");
  const { work, error } = useSharedWork(account_id);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const sharedIds = new Set(shared.map((p) => p.project_id));
  const projectTitle = (id: string) =>
    (project_map?.getIn([id, "title"]) as string | undefined) ?? "";
  // Conversations they have written in, in projects we both belong to.
  const theirs = conversations.filter(
    (c) =>
      sharedIds.has(c.project_id) && c.participant_ids.includes(account_id),
  );
  const loading = <p role="status">Loading...</p>;
  return (
    <div style={{ maxWidth: 1000 }}>
      <Button
        type="text"
        icon={<Icon name="arrow-left" />}
        onClick={onBack}
        style={{ marginBottom: 8 }}
      >
        All collaborators
      </Button>
      <Space align="center" size="middle" wrap style={{ marginBottom: 12 }}>
        <Avatar account_id={account_id} size={48} />
        <Typography.Title level={3} style={{ margin: 0 }}>
          {person?.name ?? "Collaborator"}
        </Typography.Title>
        {person?.alias && (
          <span style={{ color: UI_COLORS.link }}>@{person.alias}</span>
        )}
        <Button type="primary" onClick={onStartConversation}>
          Start conversation
        </Button>
        <Button
          icon={<Icon name="robot" />}
          onClick={() =>
            void import("@cocalc/frontend/agents/agent-participants").then(
              ({ openNewAgentWith }) => openNewAgentWith([account_id]),
            )
          }
        >
          New agent with {firstName(person?.name)}
        </Button>
        <Button
          aria-pressed={!!person?.pinned}
          icon={<Icon name="pushpin" />}
          onClick={() =>
            void setPersonState(account_id, { pinned: !person?.pinned })
          }
        >
          {person?.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button onClick={() => setAliasOpen(true)}>Personal alias</Button>
        <Button onClick={() => setInviteOpen(true)}>Invite to projects</Button>
      </Space>
      {error && <Alert role="alert" type="error" title={error} />}
      <Tabs
        items={[
          {
            key: "conversations",
            label: `Conversations (${theirs.length})`,
            children: (
              <ConversationCollection
                view="list"
                conversations={theirs}
                onSelect={onOpenConversation}
                emptyText="No conversations with this person yet."
              />
            ),
          },
          {
            key: "agents",
            label: `Agents${work ? ` (${work.agents.length})` : ""}`,
            children: !work ? (
              loading
            ) : (
              <>
                <Typography.Paragraph type="secondary">
                  Agents {person?.name ?? "they"} registered in projects you
                  share. Any collaborator on a project can open and message its
                  agents; turns you start use your own credentials. Open one and
                  choose “Add to my agents” to keep it in your sidebar.
                </Typography.Paragraph>
                {work.agents.length === 0 ? (
                  <Typography.Paragraph type="secondary">
                    No agents in shared projects.
                  </Typography.Paragraph>
                ) : (
                  <div role="list" aria-label="Shared agents">
                    {work.agents.map((agent) => (
                      <div role="listitem" key={agent.agent_id}>
                        <button
                          type="button"
                          style={ROW}
                          onClick={() =>
                            void redux
                              .getProjectActions(agent.project_id)
                              ?.open_file({
                                path: agent.path,
                                foreground: true,
                                fragmentId: { thread: agent.thread_id },
                              })
                              .then(() =>
                                redux
                                  .getActions("page")
                                  .set_active_tab(agent.project_id),
                              )
                          }
                        >
                          <Cell>
                            @{agent.name}
                            {agent.collaborator_access === "view" && (
                              <span
                                title={VIEW_ONLY_NOTE}
                                style={{
                                  marginLeft: 8,
                                  color: UI_COLORS.warning,
                                  fontSize: 12,
                                }}
                              >
                                view only, by request
                              </span>
                            )}
                          </Cell>
                          <Cell secondary>
                            {projectTitle(agent.project_id)}
                          </Cell>
                          <Cell grow={0.6} secondary>
                            <TimeAgo date={new Date(agent.created_at)} />
                          </Cell>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ),
          },
          {
            key: "artifacts",
            label: `Artifacts${work ? ` (${work.artifacts.length})` : ""}`,
            children: !work ? (
              loading
            ) : work.artifacts.length === 0 ? (
              <Typography.Paragraph type="secondary">
                No artifacts from their agents in shared projects.
              </Typography.Paragraph>
            ) : (
              <div role="list" aria-label="Shared artifacts">
                {work.artifacts.map((artifact) => (
                  <div role="listitem" key={artifact.entry_id}>
                    <button
                      type="button"
                      style={ROW}
                      onClick={() =>
                        void import("@cocalc/frontend/agents/library-navigation").then(
                          ({ openLibrary }) =>
                            openLibrary(artifact.project_id, artifact.entry_id),
                        )
                      }
                    >
                      <Cell>{artifact.title}</Cell>
                      <Cell grow={0.6} secondary>
                        @{artifact.agent_name}
                      </Cell>
                      <Cell secondary>{projectTitle(artifact.project_id)}</Cell>
                      <Cell grow={0.6} secondary>
                        {artifact.created_at > 0 && (
                          <TimeAgo date={new Date(artifact.created_at)} />
                        )}
                      </Cell>
                    </button>
                  </div>
                ))}
              </div>
            ),
          },
          {
            key: "projects",
            label: `Shared projects (${shared.length})`,
            children: (
              <div role="list" aria-label="Shared projects">
                {shared.map((p) => (
                  <div role="listitem" key={p.project_id}>
                    <button
                      type="button"
                      style={ROW}
                      onClick={() =>
                        void redux
                          .getActions("page")
                          .set_active_tab(p.project_id)
                      }
                    >
                      <Icon name="folder-open" />
                      <Cell>{p.title}</Cell>
                    </button>
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />
      {work && work.unavailable_bays > 0 && (
        <Alert
          type="warning"
          role="status"
          title="Some shared projects could not be checked right now."
        />
      )}
      <InviteToProjectsModal
        open={inviteOpen}
        account_id={account_id}
        name={person?.name ?? "this person"}
        onClose={() => setInviteOpen(false)}
      />
      <AliasDialog
        open={aliasOpen}
        title={person?.name ?? ""}
        alias={person?.alias}
        urlKind="people"
        onClose={() => setAliasOpen(false)}
        onSave={(alias) => setPersonState(account_id, { alias })}
      />
    </div>
  );
}
