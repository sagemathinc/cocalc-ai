import { useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Popover,
  Select,
  Space,
} from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { SearchHitTime } from "@cocalc/frontend/chat/search-hit-time";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { redux } from "@cocalc/frontend/app-framework";
import { personalAgentApi } from "./api";
import { agentSearchStore } from "./search-state";
import { runAgentSearch, type AgentSearchHit } from "./search-runner";

function Excerpt({ text, query }: { text: string; query: string }) {
  const plain = text.replace(/<[^>]*>/g, " ");
  const index = plain.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return <>{plain}</>;
  return (
    <>
      {plain.slice(0, index)}
      <mark>{plain.slice(index, index + query.length)}</mark>
      {plain.slice(index + query.length)}
    </>
  );
}

function SearchHelp() {
  const [open, setOpen] = useState(false);
  return (
    <KeyboardBoundary
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Popover
        title="About conversation search"
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
        content={
          <div
            style={{
              maxWidth: "min(400px, calc(100vw - 48px))",
              maxHeight: "min(600px, calc(100dvh - 120px))",
              overflowY: "auto",
            }}
            tabIndex={0}
            role="region"
            aria-label="Conversation search help"
          >
            <strong>How matching works</strong>
            <p>
              Search is not fuzzy or semantic: there is no typo correction or
              meaning-based matching. Results are newest first, not ranked by
              relevance.
            </p>
            <p>
              All conversation messages use case-insensitive substring matching,
              including older SQLite history:
              <code> build error</code> finds that text together, and
              <code> build</code> also finds <code>building</code>. Quotes are
              literal characters, not special phrase syntax.
            </p>
            <p>
              Spaces and punctuation are literal too: no OR/AND operators or
              wildcards. Search for a phrase without adding quotes. Leading and
              trailing spaces are ignored. Search matches message text, not
              internal metadata or previous edits. HTML tags are ignored;
              accents are not removed.
            </p>
            <strong>Availability and scope</strong>
            <p>
              Searches saved conversations without starting agents or projects.
              Unavailable projects are reported separately, not as no matches.
              Conversations in archived projects or on project hosts that are
              offline cannot be searched. A stopped project can still be
              searched when its host and files are available.
            </p>
            <p>
              Current conversations are included even when agents are idle.
              Include past conversations also searches up to five recent
              conversations saved by "Start fresh conversation" per agent. Past
              results open in the project chat file without changing the agent's
              current conversation.
            </p>
            <p>
              Most recently active agents are searched first. Use the project
              filter to narrow the search. Each pass searches up to 100 agents,
              150 threads and 20 seconds, with at most 3 projects at once.
              Search more agents continues with agents not yet searched. Very
              large histories that exceed scan limits are reported as
              unavailable, not as no matches.
            </p>
            <p style={{ marginBottom: 0 }}>
              Searches saved messages, not artifacts or unsaved changes. Access
              errors and timeouts also appear under unavailable conversations.
            </p>
          </div>
        }
      >
        <Button
          aria-label="About conversation search"
          aria-expanded={open}
          type="text"
          shape="circle"
        >
          ?
        </Button>
      </Popover>
    </KeyboardBoundary>
  );
}

export function AgentSearch({
  accountId,
  agents,
  activity,
  available,
  onSelect,
  active,
}: {
  accountId: string;
  agents: NamedAgent[];
  activity: Record<string, number>;
  available: (agent: NamedAgent) => boolean;
  onSelect: (result: AgentSearchHit) => Promise<void>;
  active: boolean;
}) {
  const store = agentSearchStore(accountId);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const projects = [
    ...new Map(
      agents.map((a) => [
        a.endpoint.project_id,
        {
          value: a.endpoint.project_id,
          label: a.project_title || "Untitled project",
        },
      ]),
    ).values(),
  ];
  async function search(more = false) {
    if (store.get().busy || !state.query.trim()) return;
    const query = more ? state.searchedQuery : state.query.trim();
    const previous = more ? state.progress : undefined;
    const includePast = more ? !!state.searchedPast : state.past;
    store.set({
      busy: true,
      error: undefined,
      searchedQuery: query,
      progress: previous,
      searchedPast: includePast,
      scroll: 0,
    });
    const ordered = more
      ? (state.pending ?? [])
      : agents
          .filter(
            (a) =>
              !state.projectId || a.endpoint.project_id === state.projectId,
          )
          .sort(
            (a, b) =>
              (activity[b.endpoint.agent_id] || Date.parse(b.updated_at) || 0) -
              (activity[a.endpoint.agent_id] || Date.parse(a.updated_at) || 0),
          );
    try {
      await runAgentSearch({
        agents: ordered,
        query,
        includePast,
        available,
        canceled: () =>
          redux.getStore("account")?.get("account_id") !== accountId,
        report: (progress) =>
          store.set({
            pending: ordered.filter(
              (a) => !progress.attempted?.includes(a.endpoint.agent_id),
            ),
            progress: previous
              ? {
                  ...progress,
                  hits: [...previous.hits, ...progress.hits].sort(
                    (a, b) => (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0),
                  ),
                  searched: previous.searched + progress.searched,
                  unavailable: previous.unavailable + progress.unavailable,
                  errors: [...previous.errors, ...progress.errors],
                  limited: previous.limited || progress.limited,
                }
              : progress,
          }),
        history: async (agent) =>
          (
            await personalAgentApi().getIdentity({
              project_id: agent.endpoint.project_id,
              agent_id: agent.endpoint.agent_id,
            })
          ).conversation_history?.map((h) => h.thread_id) ?? [],
        search: async (agent, threadId, query) => {
          const result =
            await webapp_client.conat_client.hub.projects.chatStoreSearch({
              project_id: agent.endpoint.project_id,
              chat_path: agent.path,
              thread_id: threadId,
              query,
              include_head: true,
              limit: 20,
            });
          if (!result.includes_head)
            throw new Error(
              "Project host needs an update to search recent messages",
            );
          return result.hits;
        },
      });
    } catch (err) {
      store.set({ error: `${err}` });
    } finally {
      store.set({ busy: false });
    }
  }
  return (
    <>
      <Button
        block
        icon={<Icon name="search" />}
        onClick={() => store.set({ open: true })}
      >
        Search conversations
      </Button>
      <Drawer
        title="Search all agents"
        extra={<SearchHelp />}
        open={active && state.open}
        onClose={() => store.set({ open: false })}
        size={state.width}
        resizable={{ onResize: (width) => store.set({ width }) }}
        destroyOnHidden
      >
        <KeyboardBoundary
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <Input.Search
            allowClear
            aria-label="Search agent conversations"
            placeholder="Search conversation text"
            maxLength={256}
            value={state.query}
            onChange={(e) => store.set({ query: e.target.value })}
            onSearch={(_value, _event, info) => {
              if (info?.source !== "clear") void search();
            }}
            loading={state.busy}
            enterButton="Search"
          />
          <Select
            aria-label="Restrict search to project"
            placeholder="All projects"
            allowClear
            showSearch
            optionFilterProp="label"
            options={projects}
            value={state.projectId}
            onChange={(projectId) => store.set({ projectId })}
            disabled={state.busy}
          />
          <Checkbox
            checked={state.past}
            disabled={state.busy}
            onChange={(e) => store.set({ past: e.target.checked })}
          >
            Include past conversations
          </Checkbox>
          {state.error && (
            <Alert role="alert" type="error" title={state.error} />
          )}
          {state.progress && (
            <div role="status">
              Searched {state.progress.searched} agents;{" "}
              {state.progress.unavailable} unavailable;{" "}
              {state.progress.remaining} not searched.
              {state.busy
                ? " Searching..."
                : state.progress.limited
                  ? " Partial results: a search limit was reached. Use conversation search for additional hits within a thread."
                  : " Search complete."}
            </div>
          )}
          {!!state.pending?.length && !state.busy && (
            <Button onClick={() => void search(true)}>
              Search more agents
            </Button>
          )}
          {state.searchedQuery && (
            <strong>Results for “{state.searchedQuery}”</strong>
          )}
          <div
            style={{ overflowY: "auto", minHeight: 0, flex: 1 }}
            ref={(el) => {
              if (el) el.scrollTop = store.get().scroll;
            }}
            onScroll={(e) => store.set({ scroll: e.currentTarget.scrollTop })}
          >
            {state.progress?.hits.map((result) => (
              <Button
                key={`${result.agent.endpoint.agent_id}:${result.threadId}:${result.hit.message_id || result.hit.date_ms}`}
                type="text"
                style={{
                  width: "100%",
                  height: "auto",
                  whiteSpace: "normal",
                  textAlign: "left",
                  display: "block",
                  padding: 12,
                  borderBottom: `1px solid ${UI_COLORS.border}`,
                }}
                onClick={() => {
                  void onSelect(result).catch((err) =>
                    store.set({ open: true, error: `${err}` }),
                  );
                }}
              >
                <Space wrap>
                  <strong>@{result.agent.name}</strong>
                  <span>
                    {result.historical
                      ? "Past conversation"
                      : "Current conversation"}
                  </span>
                </Space>
                <SearchHitTime date={Number(result.hit.date_ms)} />
                <div>
                  <Excerpt
                    text={
                      result.hit.excerpt || result.hit.snippet || "(no preview)"
                    }
                    query={state.searchedQuery}
                  />
                </div>
              </Button>
            ))}
            {!state.busy && state.progress && !state.progress.hits.length && (
              <p>No matches in the conversations successfully searched.</p>
            )}
            {!!state.progress?.errors.length && (
              <details>
                <summary>Unavailable conversations</summary>
                <ul>
                  {state.progress.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </KeyboardBoundary>
      </Drawer>
    </>
  );
}
