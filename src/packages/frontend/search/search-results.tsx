/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The search results page (Enter in the sidebar search box). Sections for
// each kind of thing; the page the search started from comes first and is
// expanded, the rest are collapsed below. Names, titles and aliases match
// instantly from what is already loaded; messages, file names and file
// contents are searched on the project hosts, recent projects first, within
// a time budget, and only once their section is expanded.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Collapse, Spin, Typography } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { SearchHitTime } from "@cocalc/frontend/chat/search-hit-time";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  catalogResults,
  sharedArtifactCatalog,
} from "@cocalc/frontend/agents/artifact-catalog-store";
import { useArtifactNames } from "@cocalc/frontend/agents/artifact-names";
import {
  agentHistory,
  searchAgentThread,
} from "@cocalc/frontend/agents/message-search";
import {
  runAgentSearch,
  type AgentSearchHit,
  type AgentSearchProgress,
} from "@cocalc/frontend/agents/search-runner";
import { usePeople } from "@cocalc/frontend/people/collaborators";
import { matchesPerson, matchesSearch } from "@cocalc/frontend/people/scope";
import { useConversations } from "@cocalc/frontend/people/use-conversations";
import {
  searchConversations,
  SEARCH_MAX_CONVERSATIONS,
  type ConversationHit,
} from "@cocalc/frontend/people/search-dialog";
import {
  runAcrossProjects,
  searchProjectFiles,
  type ProjectSearchProgress,
} from "@cocalc/frontend/projects/file-search-runner";
import { useProjectAliases } from "@cocalc/frontend/projects/project-aliases";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  searchProjectContents,
  searchProjectSnapshots,
  type ContentHit,
  type SnapshotHit,
} from "./content-search";
import { searchableProjects } from "./searchable-projects";
import { closeSearch, useSearchState, type SearchScope } from "./search-store";

type SectionKey =
  | "agents"
  | "messages"
  | "artifacts"
  | "projects"
  | "files"
  | "contents"
  | "people"
  | "conversations"
  | "chatMessages"
  | "snapshots";

const ORDER: Record<SearchScope, SectionKey[]> = {
  agents: [
    "agents",
    "messages",
    "artifacts",
    "projects",
    "files",
    "contents",
    "people",
    "conversations",
    "chatMessages",
    "snapshots",
  ],
  projects: [
    "projects",
    "files",
    "contents",
    "agents",
    "messages",
    "artifacts",
    "people",
    "conversations",
    "chatMessages",
    "snapshots",
  ],
  artifacts: [
    "artifacts",
    "agents",
    "messages",
    "projects",
    "files",
    "contents",
    "people",
    "conversations",
    "chatMessages",
    "snapshots",
  ],
  people: [
    "people",
    "conversations",
    "chatMessages",
    "agents",
    "messages",
    "artifacts",
    "projects",
    "files",
    "contents",
    "snapshots",
  ],
};

// What starts expanded for each scope.
const EXPANDED: Record<SearchScope, SectionKey[]> = {
  agents: ["agents", "messages"],
  projects: ["projects", "files", "contents"],
  artifacts: ["artifacts"],
  people: ["people", "conversations", "chatMessages"],
};

const TITLES: Record<SectionKey, string> = {
  agents: "Agents",
  messages: "Messages with agents",
  artifacts: "Artifacts",
  projects: "Projects",
  files: "File names",
  contents: "In files",
  people: "People",
  conversations: "Conversations",
  chatMessages: "Messages in conversations",
  snapshots: "In snapshots",
};

const INSTANT_LIMIT = 50;

export interface SearchResultsProps {
  accountId: string;
  agents: NamedAgent[];
  // When each agent was last opened (most recent agents are searched first).
  activity: Record<string, number>;
  available: (agent: NamedAgent) => boolean;
  matchAgent: (agent: NamedAgent, query: string) => boolean;
  agentTitle: (agent: NamedAgent) => string;
  onOpenAgent: (agent: NamedAgent) => void;
  onOpenMessage: (hit: AgentSearchHit) => Promise<void> | void;
  onOpenArtifact: (hit: AgentSearchHit) => Promise<void> | void;
  navigation?: ReactNode;
  // No agents: their sections are left out.
  aiDisabled?: boolean;
}

export function SearchResults(props: SearchResultsProps) {
  const { query, scope, run } = useSearchState();
  const [counts, setCounts] = useState<Partial<Record<SectionKey, string>>>({});
  const [expanded, setExpanded] = useState<SectionKey[]>(EXPANDED[scope]);
  // File names and contents that found nothing (in the projects searched)
  // bring in the snapshots, e.g. to find something deleted.
  const [, setEmptyNow] = useState<SectionKey[]>([]);
  useEffect(() => {
    setExpanded(EXPANDED[scope]);
    setCounts({});
    setEmptyNow([]);
  }, [run, scope]);
  const done = (key: SectionKey) => (hits: number) => {
    if (hits > 0) return;
    setEmptyNow((keys) => {
      const next = keys.includes(key) ? keys : [...keys, key];
      if (next.includes("files") && next.includes("contents"))
        setExpanded((open) =>
          open.includes("snapshots") ? open : [...open, "snapshots"],
        );
      return next;
    });
  };
  const report = (key: SectionKey) => (count: string) =>
    setCounts((c) => (c[key] === count ? c : { ...c, [key]: count }));

  const sections: Record<SectionKey, ReactNode> = {
    agents: (
      <AgentsSection {...props} query={query} onCount={report("agents")} />
    ),
    messages: (
      <MessagesSection {...props} query={query} onCount={report("messages")} />
    ),
    artifacts: (
      <ArtifactsSection
        {...props}
        query={query}
        onCount={report("artifacts")}
      />
    ),
    projects: <ProjectsSection query={query} onCount={report("projects")} />,
    files: (
      <FilesSection
        query={query}
        onCount={report("files")}
        onDone={done("files")}
      />
    ),
    contents: (
      <ContentsSection
        query={query}
        onCount={report("contents")}
        onDone={done("contents")}
      />
    ),
    snapshots: <SnapshotsSection query={query} onCount={report("snapshots")} />,
    people: <PeopleSection query={query} onCount={report("people")} />,
    conversations: (
      <ConversationsSection query={query} onCount={report("conversations")} />
    ),
    chatMessages: (
      <ConversationMessagesSection
        query={query}
        onCount={report("chatMessages")}
      />
    ),
  };

  return (
    <div
      role="region"
      aria-label="Search results"
      style={{
        height: "100%",
        overflowY: "auto",
        background: UI_COLORS.page,
        color: UI_COLORS.text,
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "12px 16px 32px",
          boxSizing: "border-box",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          {props.navigation}
          <Button
            type="text"
            aria-label="Close search"
            icon={<Icon name="arrow-left" />}
            onClick={() => closeSearch({ restoreUrl: true })}
          />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, minWidth: 0 }}>
            Search: <span style={{ fontWeight: 400 }}>“{query}”</span>
          </h1>
        </header>
        <Collapse
          key={run}
          activeKey={expanded}
          onChange={(keys) =>
            setExpanded((Array.isArray(keys) ? keys : [keys]) as SectionKey[])
          }
          items={ORDER[scope]
            .filter(
              (key) =>
                !props.aiDisabled || (key !== "agents" && key !== "messages"),
            )
            .map((key) => ({
              key,
              label: (
                <span>
                  <strong>{TITLES[key]}</strong>
                  {counts[key] != null && (
                    <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                      {counts[key]}
                    </Typography.Text>
                  )}
                </span>
              ),
              children: sections[key],
            }))}
        />
      </div>
    </div>
  );
}

// ---- rows ----

function ResultRow({
  title,
  detail,
  meta,
  onOpen,
  label,
}: {
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  onOpen: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: 0,
        borderBottom: `1px solid ${UI_COLORS.border}`,
        background: "transparent",
        color: UI_COLORS.text,
        padding: "8px 4px",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 500 }}>{title}</span>
        {meta && (
          <span style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
            {meta}
          </span>
        )}
      </div>
      {detail && (
        <div
          style={{
            color: UI_COLORS.secondary,
            fontSize: 13,
            marginTop: 2,
            overflowWrap: "anywhere",
          }}
        >
          {detail}
        </div>
      )}
    </button>
  );
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
      {children}
    </Typography.Paragraph>
  );
}

function limited<T>(items: T[]): T[] {
  return items.slice(0, INSTANT_LIMIT);
}

function useReportCount(onCount: (count: string) => void, count: string) {
  useEffect(() => onCount(count), [count]);
}

async function openProjectFile(
  project_id: string,
  path: string,
  line?: number,
) {
  await redux.getActions("projects").open_project({
    project_id,
    switch_to: true,
  });
  await ensureProjectReduxRuntime();
  await redux
    .getProjectActions(project_id)
    ?.open_file({ path, line, foreground: true });
  closeSearch();
}

function openPeopleRoute(route: string) {
  const page = redux.getActions("page");
  page.setState({ people_route: route });
  void page.set_active_tab("people");
  closeSearch();
}

function useProjectTitle() {
  const project_map = useTypedRedux("projects", "project_map");
  return (project_id: string) =>
    (project_map?.getIn([project_id, "title"]) as string | undefined) ||
    "Untitled project";
}

// ---- instant sections ----

function AgentsSection({
  agents,
  query,
  matchAgent,
  agentTitle,
  onOpenAgent,
  onCount,
}: SearchResultsProps & { query: string; onCount: (c: string) => void }) {
  const hits = agents.filter((agent) => matchAgent(agent, query));
  useReportCount(onCount, `${hits.length}`);
  if (!hits.length) return <Empty>No agents match.</Empty>;
  return (
    <>
      {limited(hits).map((agent) => (
        <ResultRow
          key={agent.endpoint.agent_id}
          label={`Open agent ${agentTitle(agent)}`}
          title={
            <>
              <Highlight text={agentTitle(agent)} query={query} />{" "}
              <span style={{ color: UI_COLORS.link }}>@{agent.name}</span>
            </>
          }
          meta={agent.project_title}
          onOpen={() => {
            onOpenAgent(agent);
            closeSearch();
          }}
        />
      ))}
    </>
  );
}

function ArtifactsSection({
  accountId,
  agents,
  query,
  onOpenArtifact,
  onCount,
}: SearchResultsProps & { query: string; onCount: (c: string) => void }) {
  const catalog = sharedArtifactCatalog(accountId, (opts) =>
    webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
  );
  const [metadata, setMetadata] = useState(catalog.get());
  useEffect(() => catalog.subscribe(() => setMetadata(catalog.get())), []);
  const { names } = useArtifactNames();
  const hits = catalogResults(metadata.entries, agents, {
    query,
    sort: "recent",
    pins: [],
    aliases: names,
  });
  useReportCount(onCount, metadata.loading ? "…" : `${hits.length}`);
  if (!hits.length)
    return (
      <Empty>
        {metadata.loading ? "Loading artifacts…" : "No artifacts match."}
      </Empty>
    );
  return (
    <>
      {limited(hits).map((hit) => {
        const title = hit.hit.artifact_title || "Untitled artifact";
        return (
          <ResultRow
            key={`${hit.agent.endpoint.project_id}/${hit.catalogEntryId}`}
            label={`Open artifact ${title}`}
            title={<Highlight text={title} query={query} />}
            meta={`@${hit.agent.name}`}
            detail={hit.agent.project_title}
            onOpen={() => {
              void onOpenArtifact(hit);
              closeSearch();
            }}
          />
        );
      })}
    </>
  );
}

function ProjectsSection({
  query,
  onCount,
}: {
  query: string;
  onCount: (c: string) => void;
}) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const aliases = useProjectAliases();
  const q = query.toLowerCase().replace(/^@/, "");
  const hits = useMemo(
    () =>
      searchableProjects(project_map, account_id).filter((id) => {
        const title = `${project_map?.getIn([id, "title"]) ?? ""}`;
        const description = `${project_map?.getIn([id, "description"]) ?? ""}`;
        return (
          title.toLowerCase().includes(q) ||
          description.toLowerCase().includes(q) ||
          (aliases.get(id) ?? "").includes(q)
        );
      }),
    [project_map, account_id, aliases, q],
  );
  useReportCount(onCount, `${hits.length}`);
  if (!hits.length) return <Empty>No projects match.</Empty>;
  return (
    <>
      {limited(hits).map((id) => {
        const title =
          `${project_map?.getIn([id, "title"]) ?? ""}` || "Untitled";
        const alias = aliases.get(id);
        return (
          <ResultRow
            key={id}
            label={`Open project ${title}`}
            title={
              <>
                <Highlight text={title} query={query} />
                {alias && (
                  <span style={{ color: UI_COLORS.link }}> @{alias}</span>
                )}
              </>
            }
            detail={`${project_map?.getIn([id, "description"]) ?? ""}`}
            meta={
              project_map?.getIn([id, "last_edited"]) ? (
                <TimeAgo date={project_map.getIn([id, "last_edited"])} />
              ) : undefined
            }
            onOpen={() => {
              void redux
                .getActions("projects")
                .open_project({ project_id: id, switch_to: true });
              closeSearch();
            }}
          />
        );
      })}
    </>
  );
}

function PeopleSection({
  query,
  onCount,
}: {
  query: string;
  onCount: (c: string) => void;
}) {
  const hits = usePeople().filter((person) => matchesPerson(person, query));
  useReportCount(onCount, `${hits.length}`);
  if (!hits.length) return <Empty>No collaborators match.</Empty>;
  return (
    <>
      {limited(hits).map((person) => (
        <ResultRow
          key={person.account_id}
          label={`Open ${person.name}`}
          title={
            <>
              <Highlight text={person.name} query={query} />
              {person.alias && (
                <span style={{ color: UI_COLORS.link }}> @{person.alias}</span>
              )}
            </>
          }
          meta={`${person.sharedProjects} shared ${person.sharedProjects === 1 ? "project" : "projects"}`}
          onOpen={() => openPeopleRoute(`collaborators/${person.account_id}`)}
        />
      ))}
    </>
  );
}

function ConversationsSection({
  query,
  onCount,
}: {
  query: string;
  onCount: (c: string) => void;
}) {
  const state = useConversations(true);
  const projectTitle = useProjectTitle();
  const hits = state.conversations.filter((c) =>
    matchesSearch(c, query, projectTitle(c.project_id)),
  );
  useReportCount(
    onCount,
    state.loading && !state.conversations.length ? "…" : `${hits.length}`,
  );
  if (!hits.length)
    return (
      <Empty>
        {state.loading && !state.conversations.length
          ? "Loading conversations…"
          : "No conversations match."}
      </Empty>
    );
  return (
    <>
      {limited(hits).map((c) => (
        <ResultRow
          key={c.conversation_id}
          label={`Open conversation ${c.title}`}
          title={
            <>
              <Highlight text={c.title} query={query} />
              {c.alias && (
                <span style={{ color: UI_COLORS.link }}> @{c.alias}</span>
              )}
            </>
          }
          detail={projectTitle(c.project_id)}
          meta={<TimeAgo date={new Date(c.last_activity)} />}
          onOpen={() =>
            openPeopleRoute(
              `conversations/${c.project_id}/${c.conversation_id}`,
            )
          }
        />
      ))}
    </>
  );
}

// ---- searched on the hosts ----

function Coverage({
  busy,
  searched,
  unavailable,
  pending,
  unit,
  onMore,
}: {
  busy: boolean;
  searched: number;
  unavailable: number;
  pending: number;
  unit: string; // "projects"
  onMore?: () => void;
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: UI_COLORS.secondary,
        fontSize: 13,
        marginBottom: 6,
      }}
    >
      {busy && <Spin size="small" />}
      <span>
        Searched {searched} {unit}
        {unavailable ? ` · ${unavailable} unavailable` : ""}
        {pending ? ` · ${pending} not searched yet` : ""}
        {busy ? " · searching…" : ""}
      </span>
      {!busy && pending > 0 && onMore && (
        <Button size="small" onClick={onMore}>
          Search more
        </Button>
      )}
    </div>
  );
}

function useProjectSearch<T>(
  search: (
    project_id: string,
    timeout: number,
  ) => Promise<{
    items: T[];
    truncated: boolean;
  }>,
  // Called once the first pass finishes, with how many hits it found.
  onDone?: (hits: number) => void,
) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const [progress, setProgress] = useState<ProjectSearchProgress<T>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canceled] = useState(() => ({ value: false }));
  useEffect(
    () => () => {
      canceled.value = true;
    },
    [],
  );
  async function start(more = false) {
    const previous = more ? progress : undefined;
    const project_ids = more
      ? (progress?.pending ?? [])
      : searchableProjects(project_map, account_id);
    const merge = (next: ProjectSearchProgress<T>) =>
      previous
        ? {
            ...next,
            hits: [...previous.hits, ...next.hits],
            searched: [...previous.searched, ...next.searched],
            unavailable: [...previous.unavailable, ...next.unavailable],
            truncated: previous.truncated || next.truncated,
          }
        : next;
    setBusy(true);
    setError("");
    try {
      const result = await runAcrossProjects<T>({
        project_ids,
        search,
        canceled: () => canceled.value,
        report: (next) => {
          if (!canceled.value) setProgress(merge(next));
        },
      });
      if (!canceled.value) {
        setProgress(merge(result));
        if (!more) onDone?.(result.hits.length);
      }
    } catch (err) {
      if (!canceled.value) setError(`${err}`);
    } finally {
      if (!canceled.value) setBusy(false);
    }
  }
  useEffect(() => {
    void start();
  }, []);
  return { progress, busy, error, more: () => void start(true) };
}

function countLabel(
  progress: { hits: unknown[]; truncated?: boolean } | undefined,
  busy: boolean,
) {
  if (!progress) return "…";
  return `${progress.hits.length}${progress.truncated ? "+" : ""}${busy ? "…" : ""}`;
}

function groupByProject<T extends { project_id: string }>(hits: T[]) {
  const groups = new Map<string, T[]>();
  for (const hit of hits)
    groups.set(hit.project_id, [...(groups.get(hit.project_id) ?? []), hit]);
  return [...groups.entries()];
}

function FilesSection({
  query,
  onCount,
  onDone,
}: {
  query: string;
  onCount: (c: string) => void;
  onDone?: (hits: number) => void;
}) {
  const projectTitle = useProjectTitle();
  const { progress, busy, error, more } = useProjectSearch(
    async (project_id, timeout) => {
      const { paths, truncated } = await searchProjectFiles(
        project_id,
        query,
        { hidden: false, caseSensitive: false, ignore: true },
        timeout,
      );
      return {
        items: paths.map((path) => ({ project_id, path })),
        truncated,
      };
    },
    onDone,
  );
  useReportCount(onCount, countLabel(progress, busy));
  return (
    <>
      <Coverage
        busy={busy}
        searched={progress?.searched.length ?? 0}
        unavailable={progress?.unavailable.length ?? 0}
        pending={busy ? 0 : (progress?.pending.length ?? 0)}
        unit="projects"
        onMore={more}
      />
      {error && <Alert role="alert" type="error" title={error} />}
      {progress && !busy && !progress.hits.length && (
        <Empty>No file names match in the projects searched.</Empty>
      )}
      {groupByProject(progress?.hits ?? []).map(([project_id, hits]) => (
        <section key={project_id} aria-label={projectTitle(project_id)}>
          <Typography.Text strong style={{ display: "block", marginTop: 8 }}>
            {projectTitle(project_id)}
          </Typography.Text>
          {hits.map((hit) => (
            <ResultRow
              key={hit.path}
              label={`Open ${hit.path} in ${projectTitle(project_id)}`}
              title={
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                  <Highlight text={hit.path} query={query} />
                </span>
              }
              onOpen={() => void openProjectFile(project_id, hit.path)}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function ContentsSection({
  query,
  onCount,
  onDone,
}: {
  query: string;
  onCount: (c: string) => void;
  onDone?: (hits: number) => void;
}) {
  const projectTitle = useProjectTitle();
  const { progress, busy, error, more } = useProjectSearch<ContentHit>(
    (project_id, timeout) => searchProjectContents(project_id, query, timeout),
    onDone,
  );
  useReportCount(onCount, countLabel(progress, busy));
  return (
    <>
      <Coverage
        busy={busy}
        searched={progress?.searched.length ?? 0}
        unavailable={progress?.unavailable.length ?? 0}
        pending={busy ? 0 : (progress?.pending.length ?? 0)}
        unit="projects"
        onMore={more}
      />
      {error && <Alert role="alert" type="error" title={error} />}
      {progress && !busy && !progress.hits.length && (
        <Empty>No file contents match in the projects searched.</Empty>
      )}
      {groupByProject(progress?.hits ?? []).map(([project_id, hits]) => (
        <section key={project_id} aria-label={projectTitle(project_id)}>
          <Typography.Text strong style={{ display: "block", marginTop: 8 }}>
            {projectTitle(project_id)}
          </Typography.Text>
          {hits.map((hit) => (
            <ResultRow
              key={`${hit.path}:${hit.line}`}
              label={`Open ${hit.path} line ${hit.line} in ${projectTitle(project_id)}`}
              title={
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                  {hit.path}:{hit.line}
                </span>
              }
              detail={
                <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                  <Highlight text={hit.text} query={query} />
                </span>
              }
              onOpen={() =>
                void openProjectFile(project_id, hit.path, hit.line)
              }
            />
          ))}
        </section>
      ))}
    </>
  );
}

function MessagesSection({
  accountId,
  agents,
  activity,
  available,
  query,
  onOpenMessage,
  onCount,
}: SearchResultsProps & { query: string; onCount: (c: string) => void }) {
  const [progress, setProgress] = useState<AgentSearchProgress>();
  const [busy, setBusy] = useState(true);
  const [canceled] = useState(() => ({ value: false }));
  useEffect(() => {
    const ordered = [...agents].sort(
      (a, b) =>
        (activity[b.endpoint.agent_id] || Date.parse(b.updated_at) || 0) -
        (activity[a.endpoint.agent_id] || Date.parse(a.updated_at) || 0),
    );
    void runAgentSearch({
      agents: ordered,
      query,
      includePast: false,
      available,
      search: searchAgentThread,
      history: agentHistory,
      canceled: () =>
        canceled.value ||
        redux.getStore("account")?.get("account_id") !== accountId,
      report: (next) => {
        if (!canceled.value) setProgress(next);
      },
    })
      .then((result) => {
        if (!canceled.value) setProgress(result);
      })
      .finally(() => {
        if (!canceled.value) setBusy(false);
      });
    return () => {
      canceled.value = true;
    };
  }, []);
  useReportCount(
    onCount,
    progress
      ? `${progress.hits.length}${progress.limited ? "+" : ""}${busy ? "…" : ""}`
      : "…",
  );
  return (
    <>
      <Coverage
        busy={busy}
        searched={progress?.searched ?? 0}
        unavailable={progress?.unavailable ?? 0}
        pending={busy ? 0 : (progress?.remaining ?? 0)}
        unit="agents"
      />
      {progress && !busy && !progress.hits.length && (
        <Empty>No messages match in the conversations searched.</Empty>
      )}
      {progress?.hits.map((result) => (
        <ResultRow
          key={`${result.agent.endpoint.agent_id}:${result.threadId}:${result.hit.message_id || result.hit.date_ms}`}
          label={`Open message from @${result.agent.name}`}
          title={
            <span style={{ color: UI_COLORS.link }}>@{result.agent.name}</span>
          }
          meta={<SearchHitTime date={Number(result.hit.date_ms)} />}
          detail={
            <Highlight
              text={(
                result.hit.excerpt ||
                result.hit.snippet ||
                "(no preview)"
              ).replace(/<[^>]*>/g, " ")}
              query={query}
            />
          }
          onOpen={() => {
            void onOpenMessage(result);
            closeSearch();
          }}
        />
      ))}
    </>
  );
}

function SnapshotsSection({
  query,
  onCount,
}: {
  query: string;
  onCount: (c: string) => void;
}) {
  const projectTitle = useProjectTitle();
  const { progress, busy, error, more } = useProjectSearch<SnapshotHit>(
    (project_id, timeout) => searchProjectSnapshots(project_id, query, timeout),
  );
  useReportCount(onCount, countLabel(progress, busy));
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>
        File names and contents in your projects' snapshots, the newest copy of
        each.
      </Typography.Paragraph>
      <Coverage
        busy={busy}
        searched={progress?.searched.length ?? 0}
        unavailable={progress?.unavailable.length ?? 0}
        pending={busy ? 0 : (progress?.pending.length ?? 0)}
        unit="projects"
        onMore={more}
      />
      {error && <Alert role="alert" type="error" title={error} />}
      {progress && !busy && !progress.hits.length && (
        <Empty>Nothing matches in the snapshots searched.</Empty>
      )}
      {groupByProject(progress?.hits ?? []).map(([project_id, hits]) => (
        <section key={project_id} aria-label={projectTitle(project_id)}>
          <Typography.Text strong style={{ display: "block", marginTop: 8 }}>
            {projectTitle(project_id)}
          </Typography.Text>
          {hits.map((hit) => (
            <ResultRow
              key={`${hit.snapshot}/${hit.path}:${hit.line ?? ""}`}
              label={`Open ${hit.path}${hit.line ? ` line ${hit.line}` : ""} from snapshot ${hit.snapshot} in ${projectTitle(project_id)}`}
              title={
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                  {hit.line ? (
                    `${hit.path}:${hit.line}`
                  ) : (
                    <Highlight text={hit.path} query={query} />
                  )}
                </span>
              }
              meta={`snapshot ${hit.snapshot.slice(0, 16).replace("T", " ")}`}
              detail={
                hit.text ? (
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                    <Highlight text={hit.text} query={query} />
                  </span>
                ) : undefined
              }
              onOpen={() =>
                void openProjectFile(
                  project_id,
                  `.snapshots/${hit.snapshot}/${hit.path}`,
                  hit.line,
                )
              }
            />
          ))}
        </section>
      ))}
    </>
  );
}

function ConversationMessagesSection({
  query,
  onCount,
}: {
  query: string;
  onCount: (c: string) => void;
}) {
  const state = useConversations(true);
  const projectTitle = useProjectTitle();
  const [hits, setHits] = useState<ConversationHit[]>();
  const [searched, setSearched] = useState(0);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(true);
  const [started, setStarted] = useState(false);
  const [canceled] = useState(() => ({ value: false }));
  useEffect(
    () => () => {
      canceled.value = true;
    },
    [],
  );
  // Start once the conversation list is available.
  useEffect(() => {
    if (started || (state.loading && !state.conversations.length)) return;
    setStarted(true);
    void searchConversations({
      conversations: state.conversations,
      query,
      concurrency: 4,
      canceled: () => canceled.value,
      onProgress: (next, searchedCount, failedCount) => {
        setHits(next);
        setSearched(searchedCount);
        setFailed(failedCount);
      },
    }).finally(() => {
      if (!canceled.value) setBusy(false);
    });
  }, [state.loading, state.conversations, started]);
  const total = Math.min(state.conversations.length, SEARCH_MAX_CONVERSATIONS);
  useReportCount(
    onCount,
    hits == null ? "…" : `${hits.length}${busy ? "…" : ""}`,
  );
  return (
    <>
      <Coverage
        busy={busy}
        searched={searched}
        unavailable={failed}
        pending={busy ? 0 : Math.max(0, total - searched - failed)}
        unit={`of the ${total} most recent conversations`}
      />
      {!busy && hits != null && !hits.length && (
        <Empty>No messages match in the conversations searched.</Empty>
      )}
      {hits?.map(({ conversation: c, hit }) => (
        <ResultRow
          key={`${c.conversation_id}:${hit.row_id}:${hit.segment_id}:${hit.date_ms}`}
          label={`Open message in ${c.title}`}
          title={c.title}
          meta={
            hit.date_ms ? (
              <SearchHitTime date={Number(hit.date_ms)} />
            ) : undefined
          }
          detail={
            <>
              <Highlight
                text={`${hit.excerpt || hit.snippet || "(no preview)"}`.replace(
                  /<[^>]*>/g,
                  " ",
                )}
                query={query}
              />
              <span style={{ marginLeft: 8 }}>
                · {projectTitle(c.project_id)}
              </span>
            </>
          }
          onOpen={() =>
            openPeopleRoute(
              `conversations/${c.project_id}/${c.conversation_id}`,
            )
          }
        />
      ))}
    </>
  );
}
