import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ArtifactCatalogItem } from "@cocalc/util/artifact-catalog";
import type { AgentSearchHit } from "./search-runner";

export interface CatalogEntry {
  entry_id: string;
  project_id: string;
  chat_path: string;
  item: ArtifactCatalogItem;
}
export interface CatalogPage {
  entries: CatalogEntry[];
  next?: string;
  indexed_sources: number;
}
type ListProject = (opts: {
  project_id: string;
  after?: string;
}) => Promise<CatalogPage>;

export const CATALOG_LIMITS = {
  projects: 100,
  pages: 100,
  entries: 10_000,
  // Bound retained UTF-16 metadata as well as row count (roughly 16 MiB).
  characters: 8_000_000,
  refreshMs: 10_000,
  timeoutMs: 20_000,
};

interface CatalogState {
  entries: CatalogEntry[];
  loading: boolean;
  incomplete: boolean;
  limited: boolean;
  indexedSources: number;
  checkedProjects: number;
  error?: string;
}
const empty = (): CatalogState => ({
  entries: [],
  loading: false,
  incomplete: true,
  limited: false,
  indexedSources: 0,
  checkedProjects: 0,
});

/** Mount-owned, account-scoped memory only. No cache survives unmount/logout. */
export class ArtifactCatalogStore {
  private state = empty();
  private listeners = new Set<() => void>();
  private projects: string[] = [];
  private generation = 0;
  private mounted = false;
  private running = false;
  private interval?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(
    readonly accountId: string,
    private listProject: ListProject,
  ) {}

  get = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: CatalogState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  start(projects: string[]) {
    this.stop();
    if (!this.accountId) return;
    this.projects = [...new Set(projects)].sort();
    this.mounted = true;
    void this.refresh();
    this.interval = setInterval(
      () => void this.refresh(),
      CATALOG_LIMITS.refreshMs,
    );
  }

  stop = () => {
    this.mounted = false;
    this.generation++;
    clearInterval(this.interval);
    clearTimeout(this.timeout);
    this.projects = [];
    this.publish(empty());
  };

  refresh = async () => {
    if (!this.mounted || this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const current = () => this.mounted && generation === this.generation;
    const projects = this.projects.slice(0, CATALOG_LIMITS.projects);
    let pages = 0,
      characters = 0;
    const entries = new Map<string, CatalogEntry>();
    const sources = new Map<string, number>();
    let checkedProjects = 0;
    let incomplete = projects.length < this.projects.length;
    this.publish({ ...this.state, loading: true, error: undefined });
    this.timeout = setTimeout(() => {
      if (!current()) return;
      this.generation++;
      this.publish({
        ...empty(),
        error:
          "Catalog refresh timed out; coverage is incomplete. Waiting for the outstanding request before retrying.",
      });
      // Keep the RPC slot occupied until the actual promise settles.
    }, CATALOG_LIMITS.timeoutMs);
    try {
      projectLoop: for (const project_id of projects) {
        let after: string | undefined;
        const cursors = new Set<string>();
        do {
          if (
            pages >= CATALOG_LIMITS.pages ||
            entries.size >= CATALOG_LIMITS.entries
          ) {
            incomplete = true;
            break projectLoop;
          }
          pages++;
          const page = await this.listProject({
            project_id,
            ...(after ? { after } : {}),
          });
          if (!current()) return;
          sources.set(project_id, page.indexed_sources);
          for (const entry of page.entries) {
            if (entry.project_id !== project_id) continue;
            const key = JSON.stringify([
              project_id,
              entry.chat_path,
              entry.item.thread_id,
              entry.item.artifact_id,
            ]);
            const size = JSON.stringify(entry).length;
            if (
              entries.size >= CATALOG_LIMITS.entries ||
              characters + size > CATALOG_LIMITS.characters
            ) {
              incomplete = true;
              break projectLoop;
            }
            characters += size;
            entries.set(key, entry);
          }
          after = page.next;
          if (after && cursors.has(after)) {
            incomplete = true;
            break projectLoop;
          }
          if (after) cursors.add(after);
          else checkedProjects++;
        } while (after);
      }
      if (current())
        this.publish({
          entries: [...entries.values()],
          loading: false,
          incomplete,
          limited: incomplete,
          indexedSources: [...sources.values()].reduce((a, b) => a + b, 0),
          checkedProjects,
        });
    } catch {
      // Fail closed on all errors, including auth/access errors, without relying
      // on unstable RPC error strings. The next poll rechecks authorization.
      if (current())
        this.publish({
          ...empty(),
          error:
            "Catalog unavailable or access changed. Cached metadata cleared; retrying periodically.",
        });
    } finally {
      if (current()) clearTimeout(this.timeout);
      this.running = false;
    }
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sourceKey = (project: string, path: string, thread: string) =>
  JSON.stringify([project, path, thread]);
export const artifactIdentity = ({ agent, hit }: AgentSearchHit) =>
  JSON.stringify([
    agent.endpoint.project_id,
    agent.path,
    agent.thread_id,
    hit.artifact_id,
  ]);

/** Only current, known agents can be opened by the existing Workbench handler. */
export function catalogResults(
  entries: CatalogEntry[],
  agents: NamedAgent[],
  {
    query = "",
    project,
    sort = "recent",
    pins = [],
  }: { query?: string; project?: string; sort?: string; pins?: string[] } = {},
): AgentSearchHit[] {
  const known = new Map<string, NamedAgent>();
  for (const agent of [...agents].sort((a, b) =>
    compare(a.endpoint.agent_id, b.endpoint.agent_id),
  )) {
    const key = sourceKey(
      agent.endpoint.project_id,
      agent.path,
      agent.thread_id,
    );
    if (!known.has(key)) known.set(key, agent);
  }
  const needle = query.trim().toLowerCase();
  const results: AgentSearchHit[] = [];
  for (const entry of entries) {
    const item = entry.item;
    const agent = known.get(
      sourceKey(entry.project_id, entry.chat_path, item.thread_id),
    );
    if (!agent || (project && project !== entry.project_id)) continue;
    if (
      needle &&
      ![
        item.title,
        item.description,
        item.kind,
        item.target?.path,
        item.target?.repository,
        item.target?.sha,
        agent.name,
        entry.chat_path,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
      continue;
    results.push({
      agent,
      threadId: item.thread_id,
      historical: false,
      hit: {
        row_id: 0,
        segment_id: "head",
        thread_id: item.thread_id,
        artifact_id: item.artifact_id,
        artifact_title: item.title,
        artifact_kind: item.kind,
        date_ms: item.created_at,
        message_id: item.publication.message_id,
        operation_id: item.publication.operation_id,
        excerpt: item.description,
      },
    });
  }
  return results.sort((a, b) => {
    const ai = pins.indexOf(artifactIdentity(a)),
      bi = pins.indexOf(artifactIdentity(b));
    if (ai >= 0 || bi >= 0) return ai < 0 ? 1 : bi < 0 ? -1 : ai - bi;
    const order =
      sort === "title"
        ? compare(a.hit.artifact_title ?? "", b.hit.artifact_title ?? "")
        : (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0);
    return order || compare(artifactIdentity(a), artifactIdentity(b));
  });
}
