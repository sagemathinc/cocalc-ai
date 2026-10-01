import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";

export interface ConversationSearchTarget {
  id: string;
  project_id: string;
  path: string;
  thread_id: string;
  title: string;
  project_title?: string;
  activity: number;
}

export interface ConversationSearchHit {
  catalogEntryId?: string;
  target: ConversationSearchTarget;
  threadId: string;
  historical: boolean;
  hit: ChatStoreSearchHit;
}
export interface ConversationSearchProgress {
  hits: ConversationSearchHit[];
  searched: number;
  unavailable: number;
  remaining: number;
  limited: boolean;
  errors: string[];
  attempted?: string[];
}

// Kept across drawer lifetimes and query changes. A timed-out RPC retains its
// slot until it actually settles, so repeated searches cannot multiply work.
const occupiedProjects = new Set<string>();
export async function boundedProjectSearch<T>(
  project: string,
  work: () => Promise<T>,
): Promise<T> {
  if (occupiedProjects.size >= 1 || occupiedProjects.has(project))
    throw new Error(
      "A previous project search is still finishing; try again shortly.",
    );
  occupiedProjects.add(project);
  try {
    return await work();
  } finally {
    occupiedProjects.delete(project);
  }
}

export async function runConversationSearch({
  targets,
  query,
  includePast,
  available,
  search,
  history,
  report,
  canceled,
  now = Date.now,
  budgetMs = 20000,
}: {
  targets: ConversationSearchTarget[];
  query: string;
  includePast: boolean;
  available: (target: ConversationSearchTarget) => boolean;
  search: (
    target: ConversationSearchTarget,
    threadId: string,
    query: string,
  ) => Promise<ChatStoreSearchHit[]>;
  history: (target: ConversationSearchTarget) => Promise<string[]>;
  report: (progress: ConversationSearchProgress) => void;
  canceled: () => boolean;
  now?: () => number;
  budgetMs?: number;
}): Promise<ConversationSearchProgress> {
  const deadline = now() + budgetMs;
  const progress: ConversationSearchProgress = {
    hits: [],
    searched: 0,
    unavailable: 0,
    remaining: targets.length,
    limited: false,
    errors: [],
    attempted: [],
  };
  let threadRequests = 0;
  const publish = () => {
    progress.hits.sort((a, b) => (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0));
    progress.hits = progress.hits.slice(0, 100);
    report({
      ...progress,
      hits: [...progress.hits],
      errors: [...progress.errors],
      attempted: [...progress.attempted!],
    });
  };
  const timed = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Search timed out")),
            Math.max(1, Math.min(8000, deadline - now())),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (let start = 0; start < Math.min(100, targets.length); start += 20) {
    if (canceled() || now() >= deadline || progress.hits.length >= 40) break;
    const pending = targets.slice(start, Math.min(start + 20, 100));
    const active = new Set<string>();
    const worker = async () => {
      while (!canceled() && now() < deadline && threadRequests < 150) {
        const index = pending.findIndex((a) => !active.has(a.project_id));
        if (index < 0) return;
        const [target] = pending.splice(index, 1);
        progress.attempted!.push(target.id);
        active.add(target.project_id);
        try {
          if (!available(target))
            throw new Error("Conversation or its project is unavailable");
          const hits = await timed(
            boundedProjectSearch(target.project_id, async () => {
              const found: ConversationSearchHit[] = [];
              const threads = [target.thread_id];
              if (includePast) {
                const old = await history(target);
                if (old.length > 5) progress.limited = true;
                threads.push(...old.slice(-5).reverse());
              }
              for (const threadId of [...new Set(threads)]) {
                if (canceled() || now() >= deadline || threadRequests >= 150) {
                  progress.limited = true;
                  break;
                }
                threadRequests++;
                const rows = await search(target, threadId, query);
                if (rows.length >= 20) progress.limited = true;
                for (const hit of rows)
                  found.push({
                    target,
                    threadId,
                    historical: threadId !== target.thread_id,
                    hit,
                  });
              }
              return found;
            }),
          );
          if (!canceled()) progress.hits.push(...hits);
          progress.searched++;
        } catch (err) {
          progress.unavailable++;
          progress.errors.push(
            `${target.title}: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          active.delete(target.project_id);
          progress.remaining--;
          if (!canceled()) publish();
        }
      }
    };
    await worker();
    if (pending.length) break;
  }
  progress.limited ||= progress.remaining > 0;
  if (!canceled()) publish();
  return progress;
}
