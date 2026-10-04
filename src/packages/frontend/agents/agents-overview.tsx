/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Agents page: every agent you can use, as cards or rows, with the same
// pinned section and drag-to-reorder as People and the Library. "Mine" pins
// are the sidebar's pins; "Shared with me" lists agents other people
// registered in projects you collaborate on.

import { PageSearchBox } from "@cocalc/frontend/search/page-search-box";
import { useListQuery } from "@cocalc/frontend/search/list-query";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Alert, Button, Checkbox, Grid, Select, Tabs, Typography } from "antd";
import {
  displayOrder,
  rangeSelection,
} from "@cocalc/frontend/components/collection-selection";
import {
  agentPaymentSummary,
  paymentGroups,
  SetPaymentModal,
  useAgentPayments,
} from "./agent-payments";
import { WithAgentRuntimeMark } from "./agent-runtime-mark";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { PageCreateButton } from "@cocalc/frontend/components/page-create-button";
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
  // Bulk operations on selected agents of your own.
  onSetHidden: (agentIds: string[], hidden: boolean) => void;
  onRemove: (agents: NamedAgent[]) => void;
  onNewAgent?: () => void;
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
  // The search box (shared with the sidebar's) narrows the agents.
  const search = useListQuery();
  const [sort, setSort] = useState<Sort>("recent");
  const [group, setGroup] = useState<Group>("none");
  const shared = useSharedAgents(active);
  const payments = useAgentPayments(active);
  // Phones: two-line rows and compact controls.
  const narrow = !!Grid.useBreakpoint().xs;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const anchor = useRef<string | undefined>(undefined);
  // Selection is for your own agents; switching tabs starts over.
  useEffect(() => setSelectedIds([]), [tab]);

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
  const selecting = tab === "mine";
  const selected = new Set(selectedIds);
  const selectedAgents = mineItems
    .filter((item) => selected.has(item.id))
    .map((item) => item.mine!);
  const allSelected =
    items.length > 0 && items.every((item) => selected.has(item.id));
  function toggleSelected(id: string, on: boolean, shift: boolean) {
    if (shift && anchor.current != null) {
      setSelectedIds(
        rangeSelection({
          order: displayOrder(
            items.map((item) => item.id),
            minePins,
            group === "project"
              ? (x) => items.find((item) => item.id === x)?.project_id ?? ""
              : undefined,
          ),
          selected: selectedIds,
          anchor: anchor.current,
          id,
          on,
          selectable: () => true,
        }),
      );
    } else {
      setSelectedIds(
        on
          ? [...selectedIds.filter((x) => x !== id), id]
          : selectedIds.filter((x) => x !== id),
      );
    }
    anchor.current = id;
  }
  const paymentFor = (item: OverviewItem) => {
    const thread_id = item.mine?.thread_id ?? item.shared?.thread_id;
    return thread_id && !payments.loading
      ? agentPaymentSummary(payments, {
          project_id: item.project_id,
          thread_id,
          runtime: item.mine?.runtime ?? item.shared?.runtime,
          payment: item.mine?.payment,
        })
      : undefined;
  };
  const paymentTargets = selectedAgents.map((agent) => ({
    project_id: agent.endpoint.project_id,
    thread_id: agent.thread_id,
    path: agent.path,
    title: props.agentTitle(agent),
    runtime: agent.runtime,
  }));
  const groups = paymentGroups(paymentTargets);
  const canSetPayment = groups.codex.length + groups.claude.length > 0;
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
                {!narrow && (
                  <span style={{ width: 28, display: "inline-flex" }}>
                    {controls.dragHandle}
                  </span>
                )}
                {controls.pinButton}
                {controls.menu(actions(item), `More actions for @${item.name}`)}
              </div>
            );
            const checkbox = selecting ? (
              // Shift-click selects a range; keep it from also selecting text.
              <span
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault();
                }}
                style={{ display: "inline-flex" }}
              >
                <Checkbox
                  aria-label={`Select @${item.name}`}
                  checked={selected.has(item.id)}
                  onChange={(e) =>
                    toggleSelected(
                      item.id,
                      e.target.checked,
                      !!(e.nativeEvent as MouseEvent | undefined)?.shiftKey,
                    )
                  }
                />
              </span>
            ) : undefined;
            const cardProps = {
              item,
              checkbox,
              payment: paymentFor(item),
              badge: item.mine ? (
                props.renderBadge(item.mine)
              ) : (
                <WithAgentRuntimeMark runtime={item.shared?.runtime}>
                  <SharedBadge appearance={item.shared?.appearance} />
                </WithAgentRuntimeMark>
              ),
              project: projectTitle(item.project_id),
              person: item.created_by ? personName(item.created_by) : "",
              onOpen: () => open(item),
              actions: actionsNode,
            };
            return view === "grid" ? (
              <GridCard {...cardProps} />
            ) : (
              <ListRow {...cardProps} narrow={narrow} />
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
          <PageSearchBox scope="agents" />
          {props.onNewAgent && (
            <PageCreateButton label="New agent" onClick={props.onNewAgent} />
          )}
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
            {selecting && items.length > 0 ? (
              <Checkbox
                aria-label="Select all agents"
                checked={allSelected}
                indeterminate={!allSelected && selectedIds.length > 0}
                onChange={(e) =>
                  setSelectedIds(
                    e.target.checked ? items.map((item) => item.id) : [],
                  )
                }
              >
                {count(items.length)}
                {selectedIds.length > 0 && ` · ${selectedIds.length} selected`}
              </Checkbox>
            ) : (
              count(items.length)
            )}
            {tab === "shared" && shared.loading && shared.agents.length > 0
              ? " · Refreshing..."
              : ""}
          </div>
          {selecting && selectedIds.length > 0 && (
            <span
              role="toolbar"
              aria-label="Selected agents"
              style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}
            >
              <Button
                size="small"
                disabled={!canSetPayment}
                title={
                  canSetPayment
                    ? undefined
                    : "These agents use project-managed credentials"
                }
                onClick={() => setPaymentOpen(true)}
              >
                Set payment method…
              </Button>
              <Button
                size="small"
                onClick={() => props.onSetHidden(selectedIds, true)}
              >
                Hide from sidebar
              </Button>
              <Button
                size="small"
                onClick={() => props.onSetHidden(selectedIds, false)}
              >
                Show in sidebar
              </Button>
              <Button
                size="small"
                danger
                onClick={() => props.onRemove(selectedAgents)}
              >
                Remove…
              </Button>
              <Button
                size="small"
                type="text"
                onClick={() => setSelectedIds([])}
              >
                Clear
              </Button>
            </span>
          )}
          <Select
            aria-label="Sort agents"
            value={sort}
            onChange={setSort}
            style={{ minWidth: narrow ? 96 : 120 }}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" },
            ]}
          />
          <Select
            aria-label="Group agents"
            value={effectiveGroup}
            onChange={setGroup}
            style={{ minWidth: narrow ? 120 : 150 }}
            options={[
              { value: "none", label: "No grouping" },
              { value: "project", label: "By project" },
              ...(tab === "shared"
                ? [{ value: "person", label: "By person" }]
                : []),
            ]}
          />
        </div>
        {payments.error && (
          <Alert
            type="warning"
            title={`Could not load how your agents are paid: ${payments.error}`}
          />
        )}
        <SetPaymentModal
          open={paymentOpen}
          agents={paymentTargets}
          payments={payments}
          onClose={() => setPaymentOpen(false)}
        />
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
  checkbox?: ReactNode;
  /** How you pay for this agent's turns. */
  payment?: string;
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
  checkbox,
  payment,
  badge,
  project,
  person,
  onOpen,
  actions,
}: CardProps) {
  return (
    <div
      style={{
        height: 152,
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
      <div style={{ flex: 1, display: "flex", gap: 8, minHeight: 0 }}>
        {checkbox && <div style={{ paddingTop: 6 }}>{checkbox}</div>}
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            {badge}
            <Title item={item} />
          </span>
          <span
            style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}
          >
            {person ? `${person} · ${project}` : project}
            {item.description ? ` · ${item.description}` : ""}
          </span>
          {payment && (
            <span
              title="How you pay for this agent's turns"
              style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 12 }}
            >
              <Icon name="credit-card" /> {payment}
            </span>
          )}
        </button>
      </div>
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
function ListRow({
  item,
  checkbox,
  payment,
  badge,
  project,
  person,
  onOpen,
  actions,
  narrow,
}: CardProps & { narrow?: boolean }) {
  if (narrow)
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px 8px 8px",
          border: `1px solid ${UI_COLORS.border}`,
          marginTop: -1,
          background: UI_COLORS.surface,
          opacity: item.available ? undefined : 0.7,
        }}
      >
        {checkbox}
        <button
          type="button"
          aria-label={`Open @${item.name}`}
          onClick={onOpen}
          style={{
            ...OPEN_BUTTON,
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {badge}
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              flex: 1,
              gap: 2,
            }}
          >
            <Title item={item} />
            <span
              style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 12 }}
            >
              {[person || project, payment].filter(Boolean).join(" · ")}
            </span>
            <span
              style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 12 }}
            >
              <Activity item={item} />
            </span>
          </span>
        </button>
        {actions}
      </div>
    );
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
      {checkbox}
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
        <span
          title={payment ? "How you pay for this agent's turns" : undefined}
          style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}
        >
          {person || payment || item.description || ""}
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
