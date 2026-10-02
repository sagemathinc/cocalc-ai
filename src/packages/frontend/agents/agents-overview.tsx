/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Agents page: every agent you can use, as cards or rows, with the same
// pinned section and drag-to-reorder as People and the Library. "Mine" pins
// are the sidebar's pins; "Shared with me" lists agents other people
// registered in projects you collaborate on.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Alert, Input, Select, Tabs, Typography } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import {
  Collection,
  CollectionViewControl,
  type CollectionMenuAction,
  type CollectionView,
} from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { VIEW_ONLY_NOTE } from "@cocalc/frontend/people/agent-access-dialog";
import { peopleApi } from "@cocalc/frontend/people/api";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ProjectAgent } from "@cocalc/util/people";
import type { AgentAppearance } from "@cocalc/util/agent-appearance";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";

export interface OverviewItem {
  id: string;
  name: string;
  title: string;
  project_id: string;
  description?: string;
  activity: number;
  available: boolean;
  hidden?: boolean;
  created_by?: string;
  view_only?: boolean;
  mine?: NamedAgent;
  shared?: ProjectAgent;
}

type Tab = "mine" | "shared";
type Sort = "recent" | "name";
type Group = "none" | "project" | "person";

interface Props {
  active: boolean;
  navigation?: ReactNode;
  mine: NamedAgent[];
  minePins: string[];
  // Hidden from the sidebar; still listed here.
  hiddenIds: string[];
  lastOpened: Record<string, number>;
  agentTitle: (agent: NamedAgent) => string;
  renderBadge: (agent: NamedAgent) => ReactNode;
  mineActions: (agent: NamedAgent) => CollectionMenuAction[];
  onPinMine: (agentId: string, pinned: boolean) => void;
  // Move within the full list of pinned agents (the sidebar's order).
  onMoveMine: (agentId: string, index: number) => void;
  onOpenMine: (agent: NamedAgent) => void;
}

// Open another person's agent: its conversation, in its project.
export function openSharedAgent(agent: {
  project_id: string;
  path: string;
  thread_id: string;
}): Promise<void> {
  return (
    redux
      .getProjectActions(agent.project_id)
      ?.open_file({
        path: agent.path,
        foreground: true,
        fragmentId: { thread: agent.thread_id },
      })
      .then(() => redux.getActions("page").set_active_tab(agent.project_id)) ??
    Promise.resolve()
  );
}

// `extra` adds searchable text, such as project titles and creator names.
export function filterAgents(
  items: OverviewItem[],
  search: string,
  extra: (item: OverviewItem) => string[] = () => [],
) {
  const needle = search.trim().toLowerCase().replace(/^@/, "");
  if (!needle) return items;
  return items.filter((item) =>
    [item.name, item.title, item.description, ...extra(item)]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(needle)),
  );
}

export function sortAgents(items: OverviewItem[], sort: Sort) {
  return [...items].sort((a, b) =>
    sort === "name"
      ? a.title.localeCompare(b.title)
      : b.activity - a.activity || a.title.localeCompare(b.title),
  );
}

function useSharedAgents(active: boolean) {
  const [state, setState] = useState<{
    agents: ProjectAgent[];
    loading: boolean;
    error: string;
    unavailable_bays: number;
  }>({ agents: [], loading: true, error: "", unavailable_bays: 0 });
  useEffect(() => {
    if (!active) return;
    let canceled = false;
    setState((s) => ({ ...s, loading: true }));
    peopleApi()
      .listAgents({})
      .then(({ agents, unavailable_bays }) => {
        if (!canceled)
          setState({ agents, loading: false, error: "", unavailable_bays });
      })
      .catch((err) => {
        if (!canceled)
          setState((s) => ({ ...s, loading: false, error: `${err}` }));
      });
    return () => {
      canceled = true;
    };
  }, [active]);
  return state;
}

export function AgentsOverview(props: Props) {
  const { active, navigation, mine, minePins, lastOpened } = props;
  const project_map = useTypedRedux("projects", "project_map");
  const user_map = useTypedRedux("users", "user_map");
  const preferences = useCollectionPreferences("agents");
  const view = preferences.value.view;
  const [tab, setTab] = useState<Tab>("mine");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [group, setGroup] = useState<Group>("none");
  const shared = useSharedAgents(active);

  const projectTitle = (id: string) =>
    (project_map?.getIn([id, "title"]) as string | undefined) ?? "";
  const personName = (id?: string) => {
    if (!id) return "";
    const user = user_map?.get(id);
    return displayNameFromUserRecord(user?.toJS?.() ?? user ?? {}) || "Someone";
  };

  const mineItems: OverviewItem[] = mine.map((agent) => {
    const opened = lastOpened[agent.endpoint.agent_id] ?? 0;
    const named = Date.parse(agent.updated_at ?? "");
    return {
      id: agent.endpoint.agent_id,
      name: agent.name,
      title: props.agentTitle(agent),
      project_id: agent.endpoint.project_id,
      description: agent.description,
      activity: opened || (Number.isFinite(named) ? named : 0),
      available: agent.available,
      hidden: props.hiddenIds.includes(agent.endpoint.agent_id),
      mine: agent,
    };
  });
  const sharedItems: OverviewItem[] = shared.agents.map((agent) => ({
    id: agent.agent_id,
    name: agent.name,
    title: agent.appearance?.name || agent.name,
    project_id: agent.project_id,
    activity: agent.created_at,
    available: true,
    created_by: agent.created_by,
    view_only: agent.collaborator_access === "view",
    shared: agent,
  }));
  const visible = (items: OverviewItem[]) =>
    sortAgents(
      filterAgents(items, search, (item) => [
        projectTitle(item.project_id),
        item.created_by ? personName(item.created_by) : "",
      ]),
      sort,
    );
  const items = visible(tab === "mine" ? mineItems : sharedItems);
  const sharedOrder = preferences.value.order;
  const pins =
    tab === "mine"
      ? minePins
      : sharedOrder.filter((id) => sharedItems.some((item) => item.id === id));
  const effectiveGroup: Group =
    tab === "mine" && group === "person" ? "none" : group;

  function pin(item: OverviewItem, pinned: boolean) {
    if (item.mine) return props.onPinMine(item.id, pinned);
    const order = sharedOrder.filter((id) => id !== item.id);
    preferences.setOrder(pinned ? [...order, item.id] : order);
  }
  function move(visibleIds: string[], id: string, index: number) {
    if (tab === "mine") {
      const target = visibleIds[index];
      const at = minePins.indexOf(target);
      if (at >= 0) props.onMoveMine(id, at);
      return;
    }
    preferences.setOrder(
      moveVisibleCollectionPin(sharedOrder, visibleIds, id, index),
    );
  }
  function open(item: OverviewItem) {
    if (item.mine) props.onOpenMine(item.mine);
    else if (item.shared) void openSharedAgent(item.shared);
  }
  function actions(item: OverviewItem): CollectionMenuAction[] {
    if (item.mine) return props.mineActions(item.mine);
    return [
      { key: "open", label: "Open conversation", onClick: () => open(item) },
      {
        key: "person",
        label: `About ${personName(item.created_by)}`,
        onClick: () => {
          const page = redux.getActions("page");
          page.setState({ people_route: `collaborators/${item.created_by}` });
          void page.set_active_tab("people");
        },
      },
    ];
  }

  const count = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  const collection = (
    <div
      style={
        {
          "--collection-grid-min-width": "260px",
          "--collection-heading-size": "16px",
        } as CSSProperties
      }
    >
      {items.length === 0 ? (
        <Typography.Paragraph type="secondary">
          {search
            ? "No matching agents."
            : tab === "mine"
              ? "You have no agents yet."
              : shared.loading
                ? "Loading..."
                : "No one else has registered agents in projects you share."}
        </Typography.Paragraph>
      ) : (
        <Collection<OverviewItem>
          items={items}
          itemId={(item) => item.id}
          itemTitle={(item) => `@${item.name}`}
          pins={pins}
          view={view}
          otherTitle={tab === "mine" ? "Agents" : "Shared with me"}
          group={
            effectiveGroup === "project"
              ? (item) => item.project_id
              : effectiveGroup === "person"
                ? (item) => item.created_by ?? ""
                : undefined
          }
          groupTitle={(key) =>
            effectiveGroup === "person"
              ? personName(key)
              : projectTitle(key) || key
          }
          onPin={pin}
          onMove={move}
          renderItem={(item, controls) => {
            const actionsNode = (
              <div style={CONTROLS_STYLE}>
                <span style={{ width: 28, display: "inline-flex" }}>
                  {controls.dragHandle}
                </span>
                {controls.pinButton}
                {controls.menu(actions(item), `More actions for @${item.name}`)}
              </div>
            );
            const cardProps = {
              item,
              badge: item.mine ? (
                props.renderBadge(item.mine)
              ) : (
                <SharedBadge appearance={item.shared?.appearance} />
              ),
              project: projectTitle(item.project_id),
              person: item.created_by ? personName(item.created_by) : "",
              onOpen: () => open(item),
              actions: actionsNode,
            };
            return view === "grid" ? (
              <GridCard {...cardProps} />
            ) : (
              <ListRow {...cardProps} />
            );
          }}
        />
      )}
    </div>
  );

  return (
    <div
      hidden={!active}
      role="region"
      aria-label="Agents page"
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        overflowY: "auto",
        boxSizing: "border-box",
        color: UI_COLORS.text,
        background: UI_COLORS.page,
      }}
    >
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 16px" }}>
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
            Agents
          </h1>
          <CollectionViewControl
            view={view}
            onChange={(next: CollectionView) => preferences.setView(next)}
            label="Agents"
          />
          <Input
            type="search"
            aria-label="Search agents"
            placeholder="Search agents"
            prefix={<Icon name="search" />}
            allowClear
            style={{ flex: "0 1 320px", minWidth: 0 }}
            maxLength={256}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </header>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <div
            role="status"
            aria-atomic="true"
            style={{
              color: UI_COLORS.secondary,
              fontSize: 13,
              flex: "1 1 auto",
            }}
          >
            {count(items.length)}
            {tab === "shared" && shared.loading && shared.agents.length > 0
              ? " · Refreshing..."
              : ""}
          </div>
          <Select
            aria-label="Sort agents"
            value={sort}
            onChange={setSort}
            style={{ minWidth: 120 }}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" },
            ]}
          />
          <Select
            aria-label="Group agents"
            value={effectiveGroup}
            onChange={setGroup}
            style={{ minWidth: 150 }}
            options={[
              { value: "none", label: "No grouping" },
              { value: "project", label: "By project" },
              ...(tab === "shared"
                ? [{ value: "person", label: "By person" }]
                : []),
            ]}
          />
        </div>
        {preferences.error && (
          <Alert role="alert" type="warning" title={preferences.error} />
        )}
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as Tab)}
          items={[
            {
              key: "mine",
              label: `Mine (${mineItems.length})`,
              children: tab === "mine" ? collection : null,
            },
            {
              key: "shared",
              label: `Shared with me${shared.loading && !shared.agents.length ? "" : ` (${sharedItems.length})`}`,
              children:
                tab === "shared" ? (
                  <>
                    {shared.error && (
                      <Alert role="alert" type="error" title={shared.error} />
                    )}
                    {shared.unavailable_bays > 0 && (
                      <Alert
                        type="warning"
                        title="Some projects could not be reached; this list may be incomplete."
                      />
                    )}
                    <Typography.Paragraph type="secondary">
                      Agents other people registered in projects you share. Any
                      collaborator can open and message them; turns you start
                      use your own credentials.
                    </Typography.Paragraph>
                    {collection}
                  </>
                ) : null,
            },
          ]}
        />
      </div>
    </div>
  );
}

const CONTROLS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  flexShrink: 0,
};

const ELLIPSIS: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const OPEN_BUTTON: CSSProperties = {
  border: "none",
  background: "transparent",
  color: UI_COLORS.text,
  cursor: "pointer",
  textAlign: "left",
  padding: 0,
  font: "inherit",
  minWidth: 0,
};

// The agent's stored theme, like the sidebar's badge (without run state).
function SharedBadge({ appearance }: { appearance?: AgentAppearance | null }) {
  if (appearance)
    return (
      <ThreadBadge
        icon={appearance.thread_icon}
        color={appearance.thread_color}
        accentColor={appearance.thread_accent_color}
        image={appearance.thread_image}
        fallbackIcon={
          appearance.thread_color ||
          appearance.thread_accent_color ||
          appearance.thread_image
            ? undefined
            : "robot"
        }
        size={30}
      />
    );
  return (
    <span
      aria-hidden
      style={{
        width: 30,
        height: 30,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        background: UI_COLORS.elevated,
        color: UI_COLORS.secondary,
      }}
    >
      <Icon name="robot" />
    </span>
  );
}

interface CardProps {
  item: OverviewItem;
  badge: ReactNode;
  project: string;
  person: string;
  onOpen: () => void;
  actions: ReactNode;
}

function Title({ item }: { item: OverviewItem }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={{ ...ELLIPSIS, fontWeight: 500 }}>{item.title}</span>
      <span style={{ ...ELLIPSIS, color: UI_COLORS.link, fontSize: 12 }}>
        @{item.name}
        {!item.available && (
          <span style={{ color: UI_COLORS.secondary }}> · unavailable</span>
        )}
        {item.hidden && (
          <span style={{ color: UI_COLORS.secondary }}>
            {" "}
            · hidden from sidebar
          </span>
        )}
        {item.view_only && (
          <span title={VIEW_ONLY_NOTE} style={{ color: UI_COLORS.warning }}>
            {" "}
            · view only, by request
          </span>
        )}
      </span>
    </span>
  );
}

function Activity({ item }: { item: OverviewItem }) {
  return item.activity ? (
    <span title={item.shared ? "Registered" : "Last active"}>
      <TimeAgo date={new Date(item.activity)} />
    </span>
  ) : null;
}

// Fixed height so cards in a row line up, as in People.
function GridCard({
  item,
  badge,
  project,
  person,
  onOpen,
  actions,
}: CardProps) {
  return (
    <div
      style={{
        height: 132,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "12px 12px 8px",
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        background: UI_COLORS.surface,
        opacity: item.available ? undefined : 0.7,
      }}
    >
      <button
        type="button"
        aria-label={`Open @${item.name}`}
        onClick={onOpen}
        style={{
          ...OPEN_BUTTON,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <span
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          {badge}
          <Title item={item} />
        </span>
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {person ? `${person} · ${project}` : project}
          {item.description ? ` · ${item.description}` : ""}
        </span>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 12,
            flex: 1,
          }}
        >
          <Activity item={item} />
        </span>
        {actions}
      </div>
    </div>
  );
}

// One-line row with fixed columns: agent, project, person, activity, actions.
function ListRow({ item, badge, project, person, onOpen, actions }: CardProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 52,
        padding: "0 8px 0 12px",
        border: `1px solid ${UI_COLORS.border}`,
        marginTop: -1,
        background: UI_COLORS.surface,
        opacity: item.available ? undefined : 0.7,
      }}
    >
      <button
        type="button"
        aria-label={`Open @${item.name}`}
        onClick={onOpen}
        style={{
          ...OPEN_BUTTON,
          flex: 1,
          alignSelf: "stretch",
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 3fr) minmax(0, 2fr) minmax(0, 1.2fr) minmax(88px, 120px)",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          {badge}
          <Title item={item} />
        </span>
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {project}
        </span>
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {person || item.description || ""}
        </span>
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 13,
            textAlign: "right",
          }}
        >
          <Activity item={item} />
        </span>
      </button>
      {actions}
    </div>
  );
}
