import {
  ArtifactCatalogStore,
  CATALOG_LIMITS,
  artifactIdentity,
  catalogResults,
} from "./artifact-catalog-store";
import type { CatalogEntry, CatalogPage } from "./artifact-catalog-store";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const entry = (id: string, project_id = "p"): CatalogEntry => ({
  entry_id: id,
  project_id,
  chat_path: "/a.chat",
  item: {
    artifact_id: id,
    thread_id: "t",
    title: id,
    description: "description",
    kind: "file",
    created_at: 1,
    publication: { message_id: "msg", operation_id: "op" },
    target: { path: "deep/file.txt", sha: "abcdef" },
  },
});
const page = (entries: CatalogEntry[], next?: string): CatalogPage => ({
  entries,
  next,
  indexed_sources: 3,
});
const deferred = () => {
  let resolve!: (page: CatalogPage) => void;
  const promise = new Promise<CatalogPage>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 250; i++) await Promise.resolve();
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("sequential pages, deduplicated projects, atomic background refresh and removals", async () => {
  const later = deferred();
  const list = jest
    .fn()
    .mockResolvedValueOnce(page([entry("old")]))
    .mockResolvedValueOnce(page([entry("new")], "next"))
    .mockReturnValueOnce(later.promise);
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p", "p"]);
  await flush();
  expect(list).toHaveBeenCalledTimes(1);
  expect(store.get().entries[0].entry_id).toBe("old");
  jest.advanceTimersByTime(CATALOG_LIMITS.refreshMs);
  await flush();
  expect(list).toHaveBeenNthCalledWith(3, { project_id: "p", after: "next" });
  expect(store.get().entries.map((e) => e.entry_id)).toEqual(["old"]);
  expect(store.get().loading).toBe(true);
  later.resolve(page([entry("last")]));
  await flush();
  expect(store.get().entries.map((e) => e.entry_id)).toEqual(["new", "last"]);
  expect(store.get()).toMatchObject({
    indexedSources: 3,
    checkedProjects: 1,
    incomplete: false,
    loading: false,
  });
  store.stop();
  expect(store.get().entries).toEqual([]);
});

test("saved appearance is immediate and survives stale catalog responses", async () => {
  const original = entry("a");
  const list = jest.fn().mockResolvedValue(page([original]));
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p"]);
  await flush();
  store.updateAppearance("p", "a", {
    title: "New title",
    description: "New description",
    appearance: { color: "#123456" },
  });
  expect(store.get().entries[0].item.title).toBe("New title");
  await flush();
  expect(store.get().entries[0].item.title).toBe("New title");
  list.mockResolvedValue(
    page([
      {
        ...original,
        item: {
          ...original.item,
          title: "New title",
          description: "New description",
          appearance: { color: "#123456" },
        },
      },
    ]),
  );
  await store.refresh();
  expect(store.get().entries[0].item.appearance).toEqual({ color: "#123456" });
  store.stop();
});

test("page and entry caps are explicit; supports ten thousand metadata entries", async () => {
  let calls = 0;
  const list = jest.fn(async () => {
    calls++;
    return page(
      Array.from({ length: 100 }, (_, i) => entry(`${calls}-${i}`)),
      `${calls}`,
    );
  });
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p"]);
  await flush();
  expect(list).toHaveBeenCalledTimes(100);
  expect(store.get().entries).toHaveLength(10_000);
  expect(store.get().incomplete).toBe(true);
  store.stop();
});

test("metadata size, project bounds, repeated cursors and deduplication", async () => {
  const large = entry("large");
  large.item.description = "x".repeat(CATALOG_LIMITS.characters);
  const list = jest.fn().mockResolvedValue(page([large]));
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p"]);
  await flush();
  expect(store.get()).toMatchObject({ entries: [], incomplete: true });
  list.mockResolvedValue(page([]));
  store.start(Array.from({ length: 101 }, (_, i) => `${i}`));
  await flush();
  expect(store.get()).toMatchObject({ checkedProjects: 100, incomplete: true });
  list.mockClear().mockResolvedValue(page([entry("same")], "repeat"));
  store.start(["p"]);
  await flush();
  expect(list).toHaveBeenCalledTimes(2);
  expect(store.get().entries).toHaveLength(1);
  expect(store.get().incomplete).toBe(true);
  store.stop();
});

test("all RPC errors purge cached metadata and periodic retry rechecks access", async () => {
  const list = jest
    .fn()
    .mockResolvedValueOnce(page([entry("secret")]))
    .mockRejectedValueOnce(Error("403"))
    .mockResolvedValue(page([entry("allowed")]));
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p"]);
  await flush();
  await store.refresh();
  expect(store.get()).toMatchObject({ entries: [], incomplete: true });
  expect(store.get().error).toMatch(/access changed/);
  jest.advanceTimersByTime(CATALOG_LIMITS.refreshMs);
  await flush();
  expect(store.get().entries[0].entry_id).toBe("allowed");
  store.stop();
});

test("account stores are isolated; stale stopped loads cannot repopulate metadata", async () => {
  const pending = deferred();
  const a = new ArtifactCatalogStore("account-a", () => pending.promise);
  const b = new ArtifactCatalogStore("account-b", async () =>
    page([entry("b")]),
  );
  a.start(["p"]);
  b.start(["p"]);
  a.stop();
  pending.resolve(page([entry("a")]));
  await flush();
  expect(a.get().entries).toEqual([]);
  expect(b.get().entries[0].entry_id).toBe("b");
  b.stop();
});

test("project changes fence stale loads, timeout keeps one outstanding slot", async () => {
  const pending = deferred();
  const list = jest
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(page([entry("new", "new-project")]));
  const store = new ArtifactCatalogStore("a", list);
  store.start(["p"]);
  store.start(["new-project"]);
  pending.resolve(page([entry("stale")]));
  await flush();
  expect(store.get().entries).toEqual([]);
  jest.advanceTimersByTime(CATALOG_LIMITS.refreshMs);
  await flush();
  expect(store.get().entries[0].entry_id).toBe("new");
  const stuck = deferred();
  list.mockReturnValue(stuck.promise);
  void store.refresh();
  jest.advanceTimersByTime(CATALOG_LIMITS.timeoutMs * 3);
  await flush();
  expect(list).toHaveBeenCalledTimes(3);
  expect(store.get().entries).toEqual([]);
  expect(store.get().error).toMatch(/timed out/);
  stuck.resolve(page([entry("late")]));
  await flush();
  expect(store.get().entries).toEqual([]);
  store.stop();
});

test("empty account never reads metadata", async () => {
  const list = jest.fn();
  const store = new ArtifactCatalogStore("", list);
  store.start(["p"]);
  await flush();
  expect(list).not.toHaveBeenCalled();
  store.stop();
});

test("local mapping uses project/path/thread, target search, deterministic sort and pins", () => {
  const agent = {
    name: "agent",
    endpoint: { project_id: "p", agent_id: "z" },
    path: "/a.chat",
    thread_id: "t",
  } as NamedAgent;
  const alias = {
    ...agent,
    name: "alias",
    endpoint: { ...agent.endpoint, agent_id: "a" },
  };
  const wrong = entry("old");
  wrong.item.thread_id = "old";
  const path = entry("path");
  path.chat_path = "/other.chat";
  const b = entry("b"),
    a = entry("a");
  const entries = [b, wrong, a, path, entry("other", "q")];
  const results = catalogResults(entries, [agent, alias]);
  expect(results.map((r) => r.hit.artifact_id)).toEqual(["a", "b"]);
  expect(results[0].agent).toBe(alias);
  expect(
    catalogResults(entries, [alias, agent], { query: "FILE.TXT" }),
  ).toEqual(results);
  expect(catalogResults(entries, [agent], { project: "q" })).toEqual([]);
  expect(catalogResults(entries, [agent], { query: "missing" })).toEqual([]);
  expect(
    catalogResults(entries, [agent], {
      sort: "title",
      pins: [artifactIdentity(results[1])],
    })[0].hit.artifact_id,
  ).toBe("b");
  a.item.created_at = 2;
  expect(catalogResults([b, a], [agent])[0].hit.artifact_id).toBe("a");
});
