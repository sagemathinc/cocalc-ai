import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { isLibraryChat, libraryChatAgent } from "./library-chat";
import type { PersonalLibraryAlias } from "@cocalc/util/personal-library";
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
  // Each refresh re-reads every page of every project, so it can be several
  // MB; poll only while someone is looking (see setPolling).
  refreshMs: 60_000,
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
  private pollingWanted = false;
  // start() while a previous request still holds the RPC slot: load once it
  // settles, since nothing else may refresh while polling is paused.
  private restartPending = false;
  private lastRefreshMs = 0;
  private interval?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private appearanceUpdates = new Map<
    string,
    {
      title: string;
      description: string;
      appearance: ArtifactCatalogItem["appearance"];
      expires: number;
    }
  >();

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

  /** Loads the catalog once; periodic refresh only runs while setPolling(true)
   * and the browser tab is visible. */
  start(projects: string[]) {
    this.stop();
    if (!this.accountId) return;
    this.projects = [...new Set(projects)].sort();
    this.mounted = true;
    if (this.running) {
      this.restartPending = true;
    } else {
      void this.refresh();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.updatePolling);
    }
  }

  private holders = new Map<number, string[]>();
  private nextHolder = 0;

  /**
   * Shared use by several visible consumers: the catalog runs while anyone
   * holds it, over the union of their projects, and stops with the last
   * release. Holders never start or stop it under each other.
   */
  acquire(projects: string[]): () => void {
    const id = this.nextHolder++;
    this.holders.set(id, projects);
    this.startForHolders();
    return () => {
      if (!this.holders.delete(id)) return;
      if (this.holders.size === 0) this.stop();
      else this.startForHolders();
    };
  }

  private startForHolders() {
    const union = [...new Set([...this.holders.values()].flat())].sort();
    if (this.mounted && JSON.stringify(union) === JSON.stringify(this.projects))
      return;
    const polling = this.pollingWanted;
    this.start(union);
    if (polling) this.setPolling(true);
  }

  /** Pause or resume periodic refresh; the last snapshot stays available to
   * every consumer either way. */
  setPolling = (wanted: boolean) => {
    this.pollingWanted = wanted;
    this.updatePolling();
  };

  private updatePolling = () => {
    const visible =
      typeof document === "undefined" || document.visibilityState !== "hidden";
    if (this.mounted && this.pollingWanted && visible) {
      if (this.interval != null) return;
      if (Date.now() - this.lastRefreshMs >= CATALOG_LIMITS.refreshMs) {
        void this.refresh();
      }
      this.interval = setInterval(
        () => void this.refresh(),
        CATALOG_LIMITS.refreshMs,
      );
    } else {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  };

  stop = () => {
    this.mounted = false;
    this.pollingWanted = false;
    this.restartPending = false;
    this.generation++;
    clearInterval(this.interval);
    this.interval = undefined;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.updatePolling);
    }
    clearTimeout(this.timeout);
    this.projects = [];
    this.appearanceUpdates.clear();
    this.publish(empty());
  };

  updateAppearance(
    projectId: string,
    entryId: string,
    update: {
      title: string;
      description: string;
      appearance: ArtifactCatalogItem["appearance"];
    },
  ) {
    const key = JSON.stringify([projectId, entryId]);
    this.appearanceUpdates.set(key, {
      ...update,
      expires: Date.now() + 120_000,
    });
    this.publish({
      ...this.state,
      entries: this.state.entries.map((entry) =>
        entry.project_id === projectId && entry.entry_id === entryId
          ? { ...entry, item: { ...entry.item, ...update } }
          : entry,
      ),
    });
    void this.refresh();
  }

  refresh = async () => {
    if (!this.mounted || this.running) return;
    this.running = true;
    this.lastRefreshMs = Date.now();
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
      if (current()) {
        const updatedEntries = [...entries.values()].map((entry) => {
          const key = JSON.stringify([entry.project_id, entry.entry_id]);
          const update = this.appearanceUpdates.get(key);
          if (!update) return entry;
          const matches =
            entry.item.title === update.title &&
            entry.item.description === update.description &&
            JSON.stringify(entry.item.appearance ?? {}) ===
              JSON.stringify(update.appearance ?? {});
          if (matches || Date.now() >= update.expires) {
            this.appearanceUpdates.delete(key);
            return entry;
          }
          return { ...entry, item: { ...entry.item, ...update } };
        });
        this.publish({
          entries: updatedEntries,
          loading: false,
          incomplete,
          limited: incomplete,
          indexedSources: [...sources.values()].reduce((a, b) => a + b, 0),
          checkedProjects,
        });
      }
    } catch {
      // Fail closed on all errors, including auth/access errors, without relying
      // on unstable RPC error strings. The next poll rechecks authorization.
      if (current()) {
        this.appearanceUpdates.clear();
        this.publish({
          ...empty(),
          error:
            "Catalog unavailable or access changed. Cached metadata cleared; retrying periodically.",
        });
      }
    } finally {
      if (current()) clearTimeout(this.timeout);
      this.running = false;
      if (this.restartPending && this.mounted) {
        this.restartPending = false;
        void this.refresh();
      }
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

/** Only current, known agents can be opened by the existing Workbench handler,
 * plus each project's Library conversation (hand-made artifacts). */
export function catalogResults(
  entries: CatalogEntry[],
  agents: NamedAgent[],
  {
    query = "",
    project,
    sort = "recent",
    pins = [],
    aliases = [],
  }: {
    query?: string;
    project?: string;
    sort?: string;
    pins?: string[];
    aliases?: PersonalLibraryAlias[];
  } = {},
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
  const personalNames = new Map(
    aliases
      .filter((alias) => alias.active)
      .map((alias) => [`${alias.project_id}/${alias.entry_id}`, alias.name]),
  );
  const results: AgentSearchHit[] = [];
  for (const entry of entries) {
    const item = entry.item;
    const agent =
      known.get(sourceKey(entry.project_id, entry.chat_path, item.thread_id)) ??
      (isLibraryChat(entry.chat_path)
        ? libraryChatAgent(entry.project_id, entry.chat_path, item.thread_id)
        : undefined);
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
        personalNames.get(`${entry.project_id}/${entry.entry_id}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
      continue;
    results.push({
      catalogEntryId: entry.entry_id,
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

// One catalog per account, shared by the Library page (which starts and
// refreshes it while the workspace is mounted) and the sidebar's list.
const shared = new Map<string, ArtifactCatalogStore>();
export function sharedArtifactCatalog(
  accountId: string,
  listProject: ListProject,
): ArtifactCatalogStore {
  let store = shared.get(accountId);
  if (!store) {
    store = new ArtifactCatalogStore(accountId, listProject);
    shared.set(accountId, store);
  }
  return store;
}
