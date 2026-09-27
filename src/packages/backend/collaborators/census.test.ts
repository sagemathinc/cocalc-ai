/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  mkdir,
  mkdtemp,
  opendir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationCensus, CollaborationCensusStore } from "./census";
import type { CensusDirectory, CensusReader, CensusRequest } from "./census";

let directory: string;
let store: CollaborationCensusStore;
let engines: CollaborationCensus[];
const request: CensusRequest = {
  project_id: "project",
  run_id: "run",
  root: "/home/user",
  volume_id: "volume",
  authority: "owner-host-epoch",
  policy_version: "home-v1",
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "collaborators-census-"));
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  engines = [];
});
afterEach(async () => {
  for (const engine of engines) await engine.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
});
function entry(name: string, kind = "file") {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  };
}
function setup(
  input: Partial<ConstructorParameters<typeof CollaborationCensus>[0]> = {},
  contents = [entry("a.chat")],
) {
  const enabled = jest.fn(() => true);
  const assertCurrent = jest.fn(async () => {});
  const read = jest.fn<ReturnType<CensusDirectory["read"]>, []>();
  const closeDirectory = jest.fn(async () => {});
  const closeReader = jest.fn(async () => {});
  const openDirectory = jest.fn(async () => {
    let index = 0;
    read.mockImplementation(async () => contents[index++] ?? null);
    return { read, close: closeDirectory };
  });
  const openReader = jest.fn(
    async (): Promise<CensusReader> => ({
      assertCurrent,
      openDirectory,
      close: closeReader,
    }),
  );
  const onError = jest.fn();
  const engine = new CollaborationCensus({
    store,
    enabled,
    openReader,
    onError,
    now: () => 0,
    ...input,
  });
  engines.push(engine);
  return {
    engine,
    enabled,
    assertCurrent,
    read,
    openDirectory,
    openReader,
    closeDirectory,
    closeReader,
    onError,
  };
}

test("constructing, enqueueing and reading metadata never opens project files", async () => {
  const { engine, openReader, enabled } = setup();
  store.begin(request);
  expect(store.status("project")?.coverage).toBe("indexing");
  expect(store.candidates(0)).toEqual([]);
  expect(openReader).not.toHaveBeenCalled();
  enabled.mockReturnValue(false);
  await engine.step();
  expect(openReader).not.toHaveBeenCalled();
});

test("each step bounds actual reads, retaining the stream instead of rescanning a large directory", async () => {
  store.begin(request);
  const { engine, read, openDirectory } = setup(
    { entriesPerStep: 3 },
    Array.from({ length: 7 }, (_, i) => entry(`${i}.chat`)),
  );
  expect(await engine.step()).toEqual({ examined: 3, completed: false });
  expect(store.candidates(0)).toHaveLength(3);
  expect(await engine.step()).toEqual({ examined: 3, completed: false });
  expect(await engine.step()).toEqual({ examined: 2, completed: true });
  expect(read).toHaveBeenCalledTimes(8);
  expect(openDirectory).toHaveBeenCalledTimes(1);
  expect(store.candidates(0)).toHaveLength(7);
});

test("restart replays unfinished directory, counting duplicates against each step budget", async () => {
  store.begin(request);
  const contents = Array.from({ length: 5 }, (_, i) => entry(`${i}.chat`));
  const first = setup({ entriesPerStep: 2 }, contents);
  await first.engine.step();
  const accepted = store.candidates(0)[0];
  store.acknowledge(accepted);
  await first.engine.close();
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  const next = setup({ entriesPerStep: 2 }, contents);
  expect(await next.engine.step()).toEqual({ examined: 2, completed: false });
  expect(store.status("project")).toMatchObject({
    entries: 2,
    pending_candidates: 1,
  });
  await next.engine.step();
  await next.engine.step();
  expect(store.status("project")).toMatchObject({
    entries: 5,
    candidates: 5,
    pending_candidates: 4,
    traversal_complete: true,
  });
  expect(store.candidates(0)).not.toContainEqual(accepted);
});

test("real streaming filesystem discovers unnamed chat extensions without any source inventory", async () => {
  const root = join(directory, "home");
  await mkdir(join(root, ".hidden", "nested"), { recursive: true });
  await mkdir(join(root, "private"));
  await mkdir(join(root, "build"));
  for (const file of [
    "unnamed.chat",
    ".hidden/legacy.sage-chat",
    ".hidden/nested/deep.chat",
    "build/user-authored.chat",
    "private/secret.chat",
    "ignored.txt",
  ])
    await writeFile(
      join(root, file),
      "legacy content is never read or modified",
    );
  await symlink(join(root, ".hidden"), join(root, "link"));
  store.begin({ ...request, root, excluded_paths: [join(root, "private")] });
  let opened = 0;
  let peak = 0;
  const openReader = jest.fn(
    async (): Promise<CensusReader> => ({
      assertCurrent: async () => {},
      openDirectory: async (path) => {
        const stream = await opendir(path);
        peak = Math.max(peak, ++opened);
        return {
          read: () => stream.read(),
          close: async () => {
            await stream.close();
            opened--;
          },
        };
      },
      close: async () => {},
    }),
  );
  const { engine } = setup({
    openReader,
    openDirectories: 2,
    entriesPerStep: 2,
  });
  for (let i = 0; i < 40; i++) await engine.step();
  expect(
    store
      .candidates(0)
      .map((x) => x.chat_path)
      .sort(),
  ).toEqual(
    [
      join(root, ".hidden/legacy.sage-chat"),
      join(root, ".hidden/nested/deep.chat"),
      join(root, "build/user-authored.chat"),
      join(root, "unnamed.chat"),
    ].sort(),
  );
  expect(store.status("project")).toMatchObject({
    traversal_complete: true,
    coverage: "partial",
    skipped_symlinks: 1,
    excluded_entries: 1,
  });
  expect(peak).toBeLessThanOrEqual(2);
  expect(opened).toBe(0);
});

test.each(["EACCES", "ENOENT", "ENOTDIR"])(
  "%s opening a volume/directory is durable incomplete work, not an empty snapshot",
  async (code) => {
    store.begin(request);
    let now = 0;
    const state = setup({ now: () => now });
    state.openReader.mockRejectedValueOnce(
      Object.assign(Error("unavailable"), { code }),
    );
    await state.engine.step();
    expect(store.status("project")).toMatchObject({
      coverage: "partial",
      traversal_complete: false,
      errors: 1,
    });
    await state.engine.step();
    expect(state.openReader).toHaveBeenCalledTimes(1);
    now = 1000;
    await state.engine.step();
    expect(store.status("project")).toMatchObject({
      traversal_complete: true,
      errors: 0,
      candidates: 1,
    });
  },
);

test("read failure replays the uncommitted batch and cannot drop its earlier candidate", async () => {
  store.begin(request);
  let now = 0;
  const state = setup({ now: () => now, entriesPerStep: 1 }, [
    entry("a.chat"),
    entry("b.chat"),
  ]);
  await state.engine.step();
  state.read.mockRejectedValueOnce(Error("I/O interrupted"));
  await state.engine.step();
  expect(store.status("project")).toMatchObject({ entries: 1, errors: 1 });
  expect(state.closeDirectory).toHaveBeenCalledTimes(1);
  now = 1000;
  await state.engine.step();
  await state.engine.step();
  await state.engine.step();
  expect(store.status("project")).toMatchObject({
    entries: 2,
    candidates: 2,
    traversal_complete: true,
    errors: 0,
  });
});

test("scope changes during a read fence publication and close the old stream", async () => {
  store.begin(request);
  const state = setup({ entriesPerStep: 1 });
  state.assertCurrent.mockImplementation(async () => {
    if (state.read.mock.calls.length)
      store.begin(
        { ...request, run_id: "new-run", volume_id: "new-volume" },
        "run",
      );
  });
  await state.engine.step();
  expect(store.candidates(0)).toEqual([]);
  expect(store.status("project")).toMatchObject({ entries: 0, errors: 0 });
  expect(state.closeDirectory).toHaveBeenCalledTimes(1);
});

test("post-read volume identity failure retains old metadata and prevents publication", async () => {
  store.begin(request);
  const state = setup();
  state.assertCurrent.mockImplementation(async () => {
    if (state.read.mock.calls.length)
      throw Object.assign(Error("volume changed"), { code: "STALE_VOLUME" });
  });
  await state.engine.step();
  expect(store.status("project")).toMatchObject({
    entries: 0,
    candidates: 0,
    coverage: "partial",
  });
  expect(state.closeDirectory).toHaveBeenCalledTimes(1);
});

test("feature disable after reading drops the uncommitted batch and releases handles", async () => {
  store.begin(request);
  const state = setup({ entriesPerStep: 1 });
  state.enabled.mockImplementation(() => !state.read.mock.calls.length);
  await state.engine.step();
  expect(store.candidates(0)).toEqual([]);
  expect(state.closeDirectory).toHaveBeenCalledTimes(1);
  state.enabled.mockReturnValue(true);
  await state.engine.step();
  expect(store.candidates(0)).toHaveLength(1);
});

test("failure after reading a candidate but before EOF never advances the batch", async () => {
  store.begin(request);
  let now = 0;
  const state = setup({ now: () => now });
  state.openDirectory.mockResolvedValueOnce({
    read: jest
      .fn()
      .mockResolvedValueOnce(entry("a.chat"))
      .mockRejectedValueOnce(Error("interrupted stream")),
    close: state.closeDirectory,
  });
  await state.engine.step();
  expect(store.status("project")).toMatchObject({
    entries: 0,
    candidates: 0,
    errors: 1,
  });
  now = 1000;
  await state.engine.step();
  expect(store.status("project")).toMatchObject({
    entries: 1,
    candidates: 1,
    traversal_complete: true,
  });
});

test("closing while the reader opens never opens a directory afterwards", async () => {
  store.begin(request);
  let resolveReader!: (reader: CensusReader) => void;
  let started!: () => void;
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const state = setup({
    openReader: () =>
      new Promise((resolve) => {
        resolveReader = resolve;
        started();
      }),
  });
  const step = state.engine.step();
  await opening;
  const closing = state.engine.close();
  resolveReader({
    assertCurrent: state.assertCurrent,
    openDirectory: state.openDirectory,
    close: state.closeReader,
  });
  await closing;
  await step;
  expect(state.openDirectory).not.toHaveBeenCalled();
  expect(state.closeReader).toHaveBeenCalledTimes(1);
  expect(store.status("project")?.traversal_complete).toBe(false);
});

test("scope is revalidated after an asynchronous feature check, immediately before commit", async () => {
  store.begin(request);
  let valid = true;
  let checks = 0;
  const state = setup({
    enabled: async () => {
      if (++checks > 1) valid = false;
      return true;
    },
  });
  state.assertCurrent.mockImplementation(async () => {
    if (!valid) throw Error("owner changed");
  });
  await state.engine.step();
  expect(store.candidates(0)).toEqual([]);
  expect(store.status("project")?.coverage).toBe("partial");
});

test("concurrent steps are single-flight and close drains an in-flight read without publishing", async () => {
  store.begin(request);
  let resolveRead!: (value: null) => void;
  let started!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closeDirectory = jest.fn(async () => {});
  const closeReader = jest.fn(async () => {});
  const { engine } = setup({
    openReader: async () => ({
      assertCurrent: async () => {},
      openDirectory: async () => ({
        read: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
            started();
          }),
        close: closeDirectory,
      }),
      close: closeReader,
    }),
  });
  const step = engine.step();
  expect(engine.step()).toBe(step);
  await readStarted;
  const closing = engine.close();
  resolveRead(null);
  await closing;
  expect(store.status("project")?.traversal_complete).toBe(false);
  expect(closeDirectory).toHaveBeenCalledTimes(1);
  expect(closeReader).toHaveBeenCalledTimes(1);
  expect(await engine.step()).toEqual({ examined: 0, completed: false });
});

test("full handle pools retain progress, bound handles and eventually reach later projects", async () => {
  for (let i = 0; i < 5; i++)
    store.begin({ ...request, project_id: `project-${i}` });
  const visited: string[] = [];
  let open = 0;
  let peak = 0;
  const { engine } = setup({
    entriesPerStep: 1,
    openDirectories: 2,
    openReader: async (run) => {
      visited.push(run.project_id);
      return {
        assertCurrent: async () => {},
        openDirectory: async () => {
          let index = 0;
          peak = Math.max(peak, ++open);
          return {
            read: async () => (index++ < 3 ? entry(`${index}.chat`) : null),
            close: async () => {
              open--;
            },
          };
        },
        close: async () => {},
      };
    },
  });
  for (let i = 0; i < 30; i++) await engine.step();
  expect(new Set(visited).size).toBe(5);
  expect(visited).toHaveLength(5);
  expect(peak).toBe(2);
  expect(open).toBe(0);
  expect(store.candidates(0)).toHaveLength(15);
});

test("a quota-blocked run releases all retained cursors instead of starving other projects", async () => {
  store.begin({ ...request, limits: { entries: 3 } });
  let open = 0;
  const openReader = jest.fn(
    async (): Promise<CensusReader> => ({
      assertCurrent: async () => {},
      openDirectory: async (path) => {
        open++;
        let index = 0;
        const entries =
          path === request.root
            ? [entry("a", "directory"), entry("b", "directory")]
            : [entry("first.chat"), entry("second.chat")];
        return {
          read: async () => entries[index++] ?? null,
          close: async () => {
            open--;
          },
        };
      },
      close: async () => {},
    }),
  );
  const state = setup({ entriesPerStep: 1, openDirectories: 2, openReader });
  for (let i = 0; i < 4; i++) await state.engine.step();
  expect(store.status("project")?.blocked_reason).toBe("entry_limit");
  expect(open).toBe(1);
  store.begin({ ...request, project_id: "later" });
  await state.engine.step();
  expect(open).toBe(1);
  expect(openReader).toHaveBeenLastCalledWith(
    expect.objectContaining({ project_id: "later" }),
  );
});

test("the cooperative elapsed-time budget also bounds each streaming step", async () => {
  store.begin(request);
  let clock = 0;
  const state = setup(
    { now: () => clock++, stepMs: 3, entriesPerStep: 100 },
    Array.from({ length: 20 }, (_, i) => entry(`${i}.chat`)),
  );
  const result = await state.engine.step();
  expect(result.examined).toBeGreaterThan(0);
  expect(result.examined).toBeLessThan(4);
  expect(store.status("project")?.traversal_complete).toBe(false);
});
