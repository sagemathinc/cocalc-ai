import { createHash, randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  artifactCatalogKey,
  type ArtifactCatalogItem,
} from "@cocalc/util/artifact-catalog";
import {
  applyArtifactCatalogSnapshot,
  artifactCatalogSourceId,
  backfillArtifactCatalogProjectState,
  registerArtifactCatalogSource,
} from "./artifact-catalog";
import {
  ARTIFACT_CATALOG_LIBRARY_CHAT_SUFFIX,
  artifactCatalogLikePattern,
  listArtifactCatalogForAccountLocal,
  parseArtifactCatalogCursor,
  validateOwnedArtifactCatalogListRequest,
  type OwnedArtifactCatalogListRequest,
} from "./artifact-catalog-list";

const bay = "bay-test";
const host_id = randomUUID();
const owner = randomUUID();
const collaborator = randomUUID();
const viewer = randomUUID();
const stranger = randomUUID();
const LIBRARY = `/home/user${ARTIFACT_CATALOG_LIBRARY_CHAT_SUFFIX}`;

async function project(
  users: Record<string, string>,
  opts: { owning_bay_id?: string | null; deleted?: boolean } = {},
): Promise<string> {
  const project_id = randomUUID();
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users,deleted)
     VALUES($1,$2,$3,$4::jsonb,$5)`,
    [
      project_id,
      host_id,
      opts.owning_bay_id === undefined ? bay : opts.owning_bay_id,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(users).map(([id, group]) => [id, { group }]),
        ),
      ),
      opts.deleted ?? false,
    ],
  );
  return project_id;
}

type Item = Partial<ArtifactCatalogItem> & {
  artifact_id: string;
  created_at: number;
};
const sources = new Map<string, { epoch: string; sequence: number }>();
const published = new Map<string, Item[]>();

function entryId(project_id: string, chat_path: string, item: Item): string {
  return createHash("sha256")
    .update(
      artifactCatalogKey(
        { project_id, chat_path },
        {
          thread_id: item.thread_id ?? "thread",
          artifact_id: item.artifact_id,
        },
      ),
    )
    .digest("hex");
}

/** Adds items to a chat's snapshot (the whole snapshot is re-sent). */
async function publish(
  project_id: string,
  items: Item[],
  chat_path = "/home/user/work.chat",
): Promise<string[]> {
  const source = { project_id, chat_path };
  const authority = { owning_bay_id: bay, host_id };
  const key = `${project_id}:${chat_path}`;
  let state = sources.get(key);
  if (!state) {
    const epoch = await registerArtifactCatalogSource(
      source,
      authority,
      null,
      randomUUID(),
    );
    state = { epoch, sequence: 0 };
    sources.set(key, state);
  }
  const all = [...(published.get(key) ?? []), ...items];
  published.set(key, all);
  state.sequence++;
  await applyArtifactCatalogSnapshot(
    {
      ...source,
      schema_version: 1,
      epoch: state.epoch,
      sequence: state.sequence,
      items: all.map((item) => ({
        thread_id: "thread",
        kind: "file",
        title: item.artifact_id,
        description: "",
        publication: { operation_id: "op", message_id: "msg" },
        ...item,
      })),
    },
    authority,
  );
  return items.map((item) => entryId(project_id, chat_path, item));
}

const list = (
  opts: Partial<OwnedArtifactCatalogListRequest> & { account_id: string },
) =>
  listArtifactCatalogForAccountLocal({
    owning_bay_id: bay,
    view: "all",
    limit: 50,
    ...opts,
  });

/** Every entry id, newest first, reading pages of `limit`. */
async function walk(
  opts: Partial<OwnedArtifactCatalogListRequest> & { account_id: string },
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let before: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = await list({ ...opts, limit, before });
    ids.push(...page.entries.map((entry) => entry.entry_id));
    expect(page.keys.length).toBe(page.entries.length);
    if (!page.more) return ids;
    before = page.keys[page.keys.length - 1];
  }
  throw Error("too many pages");
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
afterAll(async () => {
  await testCleanup();
});

describe("request validation", () => {
  test("the cursor is exactly <ms>:<64 lowercase hex>", () => {
    const e = "a".repeat(64);
    expect(parseArtifactCatalogCursor(`0:${e}`)).toEqual({
      created_ms: 0,
      entry_id: e,
    });
    expect(parseArtifactCatalogCursor(`1793820304836:${e}`)?.created_ms).toBe(
      1793820304836,
    );
    expect(parseArtifactCatalogCursor(undefined)).toBeUndefined();
    for (const bad of [
      `01:${e}`,
      `-1:${e}`,
      `1.5:${e}`,
      `1:${"A".repeat(64)}`,
      `1:${e}0`,
      `${"9".repeat(17)}:${e}`,
      `9999999999999999:${e}`,
      ` 1:${e}`,
      5,
      {},
    ])
      expect(() => parseArtifactCatalogCursor(bad)).toThrow("cursor");
  });

  test("filters are typed, of equal length and bounded", () => {
    const base = {
      account_id: owner,
      owning_bay_id: bay,
      limit: 10,
      view: "mine" as const,
    };
    const s = "b".repeat(64);
    expect(() =>
      validateOwnedArtifactCatalogListRequest({
        ...base,
        mine: { source_ids: [s], thread_ids: [] },
      }),
    ).toThrow("filter");
    expect(() =>
      validateOwnedArtifactCatalogListRequest({
        ...base,
        mine: {
          source_ids: Array(501).fill(s),
          thread_ids: Array(501).fill("t"),
        },
      }),
    ).toThrow("filter");
    expect(() =>
      validateOwnedArtifactCatalogListRequest({
        ...base,
        mine: { source_ids: ["x"], thread_ids: ["t"] },
      }),
    ).toThrow("filter");
    expect(() =>
      validateOwnedArtifactCatalogListRequest({
        ...base,
        view: "all",
        query: "x",
        alias_hits: { project_ids: ["not-a-uuid"], entry_ids: [s] },
      }),
    ).toThrow("filter");
    for (const limit of [-1, 201, 1.5, "5"])
      expect(() =>
        validateOwnedArtifactCatalogListRequest({
          ...base,
          limit: limit as any,
        }),
      ).toThrow("page size");
    expect(() =>
      validateOwnedArtifactCatalogListRequest({
        ...base,
        query: "q".repeat(201),
      }),
    ).toThrow("search");
    expect(() =>
      validateOwnedArtifactCatalogListRequest({ ...base, view: "x" as any }),
    ).toThrow("view");
  });

  test("search patterns escape LIKE metacharacters", () => {
    expect(artifactCatalogLikePattern("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });
});

describe("source ids", () => {
  test("the home bay's source id is byte-identical to the stored one", async () => {
    const p = await project({ [randomUUID()]: "owner" });
    const chat_path = "/home/user/ünïcode dir/a b.chat";
    await publish(p, [{ artifact_id: "s", created_at: 1 }], chat_path);
    const { rows } = await getPool().query(
      "SELECT DISTINCT source_id FROM artifact_catalog WHERE project_id=$1",
      [p],
    );
    expect(rows.map((row) => row.source_id)).toEqual([
      artifactCatalogSourceId({ project_id: p, chat_path }),
    ]);
  });
});

describe("authorization", () => {
  test("owners and collaborators of live projects on this bay, never viewers", async () => {
    const live = await project({
      [owner]: "owner",
      [collaborator]: "collaborator",
      [viewer]: "viewer",
    });
    const deleted = await project({ [owner]: "owner" });
    const foreign = await project({ [owner]: "owner" });
    const unassigned = await project({ [owner]: "owner" });
    const [a] = await publish(live, [{ artifact_id: "a", created_at: 1000 }]);
    // Catalogs written while live, then the project is deleted, moved away,
    // or has no recorded owning bay (which counts as this bay).
    await publish(deleted, [{ artifact_id: "d", created_at: 1001 }]);
    await publish(foreign, [{ artifact_id: "f", created_at: 1003 }]);
    await publish(unassigned, [{ artifact_id: "u", created_at: 1002 }]);
    await getPool().query(
      "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
      [deleted],
    );
    await getPool().query(
      "UPDATE projects SET owning_bay_id='bay-other' WHERE project_id=$1",
      [foreign],
    );
    await getPool().query(
      "UPDATE projects SET owning_bay_id=NULL WHERE project_id=$1",
      [unassigned],
    );
    const forOwner = await list({ account_id: owner, versions: true });
    expect(forOwner.scope.sort()).toEqual([live, unassigned].sort());
    expect(Object.keys(forOwner.versions!).sort()).toEqual(
      [live, unassigned].sort(),
    );
    expect(forOwner.scope).not.toContain(foreign);
    expect(forOwner.scope).not.toContain(deleted);
    const forCollaborator = await list({ account_id: collaborator });
    expect(forCollaborator.entries.map((e) => e.entry_id)).toEqual([a]);
    for (const account_id of [viewer, stranger]) {
      const page = await list({ account_id, versions: true });
      expect(page.entries).toEqual([]);
      expect(page.versions).toEqual({});
      expect(page.authorized).toBe(0);
    }
  });

  test("filter lists never reach outside the authorized set (R7)", async () => {
    const mineProject = await project({ [collaborator]: "owner" });
    const theirs = await project({ [stranger]: "owner" });
    const [secret] = await publish(theirs, [
      { artifact_id: "secret", created_at: 5000, thread_id: "t1" },
    ]);
    await publish(mineProject, [{ artifact_id: "own", created_at: 4000 }]);
    const theirSource = artifactCatalogSourceId({
      project_id: theirs,
      chat_path: "/home/user/work.chat",
    });
    const mine = await list({
      account_id: collaborator,
      view: "mine",
      mine: { source_ids: [theirSource], thread_ids: ["t1"] },
    });
    expect(mine.entries.map((e) => e.entry_id)).not.toContain(secret);
    const search = await list({
      account_id: collaborator,
      query: "zzz-no-text-match",
      name_hits: { source_ids: [theirSource], thread_ids: ["t1"] },
      alias_hits: { project_ids: [theirs], entry_ids: [secret] },
    });
    expect(search.entries).toEqual([]);
  });
});

describe("keyset pages", () => {
  test("ties at the same millisecond page by entry id, with no gaps or repeats", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    const ids = await publish(
      p,
      Array.from({ length: 7 }, (_, i) => ({
        artifact_id: `tie-${i}`,
        created_at: 2000,
      })),
    );
    const expected = [...ids].sort().reverse();
    expect(await walk({ account_id: reader }, 3)).toEqual(expected);
    const first = await list({ account_id: reader, limit: 3 });
    expect(first.keys[0]).toBe(`2000:${expected[0]}`);
    expect(first.more).toBe(true);
  });

  test("an insert between pages appears on a later page or not at all, never twice", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    await publish(
      p,
      Array.from({ length: 4 }, (_, i) => ({
        artifact_id: `old-${i}`,
        created_at: 3000 + i,
      })),
    );
    const first = await list({ account_id: reader, limit: 2 });
    const [newer] = await publish(p, [
      { artifact_id: "newer", created_at: 9000 },
    ]);
    const [older] = await publish(p, [{ artifact_id: "older", created_at: 1 }]);
    const second = await list({
      account_id: reader,
      limit: 10,
      before: first.keys[1],
    });
    const seen = [
      ...first.entries.map((e) => e.entry_id),
      ...second.entries.map((e) => e.entry_id),
    ];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(newer);
    expect(seen).toContain(older);
    expect(seen.length).toBe(5);
  });

  test("limit 0 returns only the versions", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    await publish(p, [{ artifact_id: "x", created_at: 10 }]);
    const page = await list({ account_id: reader, limit: 0 });
    expect(page.entries).toEqual([]);
    expect(page.more).toBe(false);
    expect(Object.keys(page.versions!)).toEqual([p]);
    expect(page.versions![p].seq).toBeGreaterThan(0);
    const without = await list({ account_id: reader, limit: 5 });
    expect(without.versions).toBeUndefined();
  });
});

describe("views and search", () => {
  test("mine: named-agent threads plus Library chats of every project", async () => {
    const reader = randomUUID();
    const withAgent = await project({ [reader]: "owner" });
    const noAgent = await project({ [reader]: "collaborator" });
    const [agentRow] = await publish(withAgent, [
      { artifact_id: "agent", created_at: 100, thread_id: "agent-thread" },
    ]);
    await publish(withAgent, [
      { artifact_id: "other", created_at: 101, thread_id: "other-thread" },
    ]);
    const [libraryRow] = await publish(
      noAgent,
      [{ artifact_id: "lib", created_at: 102, thread_id: "artifacts" }],
      LIBRARY,
    );
    // Only the suffix makes a Library chat; a lookalike name does not.
    await publish(
      noAgent,
      [{ artifact_id: "fake", created_at: 103 }],
      "/home/user/artifacts.chat",
    );
    const mine = {
      source_ids: [
        artifactCatalogSourceId({
          project_id: withAgent,
          chat_path: "/home/user/work.chat",
        }),
      ],
      thread_ids: ["agent-thread"],
    };
    expect(
      (await list({ account_id: reader, view: "mine", mine })).entries.map(
        (e) => e.entry_id,
      ),
    ).toEqual([libraryRow, agentRow]);
    expect(
      (await list({ account_id: reader, view: "all" })).entries.length,
    ).toBe(4);
  });

  test("search matches each field, escapes metacharacters, and finds nothing for no match", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    const [title, desc, kind, path, repo, sha, pct, under, slash] =
      await publish(p, [
        { artifact_id: "1", created_at: 11, title: "Quarterly Report" },
        {
          artifact_id: "2",
          created_at: 12,
          description: "about elliptic curves",
        },
        { artifact_id: "3", created_at: 13, kind: "notebook-xyz" },
        {
          artifact_id: "4",
          created_at: 14,
          target: { path: "/home/user/deep/plot.png" },
        },
        {
          artifact_id: "5",
          created_at: 15,
          target: { repository: "sagemathinc/widgets" },
        },
        { artifact_id: "6", created_at: 16, target: { sha: "deadbeefcafe" } },
        { artifact_id: "7", created_at: 17, title: "100% done" },
        { artifact_id: "8", created_at: 18, title: "snake_case" },
        { artifact_id: "9", created_at: 19, title: "back\\slash" },
      ]);
    const [chatHit] = await publish(
      p,
      [{ artifact_id: "c", created_at: 20 }],
      "/home/user/lab-notes.chat",
    );
    const find = async (query: string) =>
      (await list({ account_id: reader, query })).entries
        .map((e) => e.entry_id)
        .sort();
    expect(await find("quarterly")).toEqual([title]);
    expect(await find("ELLIPTIC")).toEqual([desc]);
    expect(await find("xyz")).toEqual([kind]);
    expect(await find("deep/plot")).toEqual([path]);
    expect(await find("widgets")).toEqual([repo]);
    expect(await find("beefca")).toEqual([sha]);
    expect(await find("lab-notes")).toEqual([chatHit]);
    expect(await find("%")).toEqual([pct]);
    expect(await find("e_c")).toEqual([under]);
    expect(await find("k\\s")).toEqual([slash]);
    expect(await find("_")).toEqual([under]);
    expect(await find("nothing-matches-this")).toEqual([]);
  });

  test("search by the requester's own agent names, aliases and the Library name", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    const [byName, byAlias] = await publish(p, [
      { artifact_id: "n", created_at: 30, thread_id: "named" },
      { artifact_id: "a", created_at: 31, thread_id: "plain" },
    ]);
    const [lib] = await publish(
      p,
      [{ artifact_id: "l", created_at: 32, thread_id: "artifacts" }],
      LIBRARY,
    );
    const source_id = artifactCatalogSourceId({
      project_id: p,
      chat_path: "/home/user/work.chat",
    });
    const page = await list({
      account_id: reader,
      query: "no-text-match",
      name_hits: { source_ids: [source_id], thread_ids: ["named"] },
      alias_hits: { project_ids: [p], entry_ids: [byAlias] },
      library_name_hit: true,
    });
    expect(page.entries.map((e) => e.entry_id).sort()).toEqual(
      [byName, byAlias, lib].sort(),
    );
  });
});

describe("scope", () => {
  test("P_max keeps the most recently active projects; project_id is always served", async () => {
    const reader = randomUUID();
    const projects: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await project({ [reader]: "owner" });
      await publish(p, [{ artifact_id: `p${i}`, created_at: 100 * (i + 1) }]);
      projects.push(p);
    }
    const page = await list({
      account_id: reader,
      max_projects: 2,
      versions: true,
    });
    expect(page.scope).toEqual([projects[4], projects[3]]);
    expect(page.too_many_projects).toBe(3);
    expect(Object.keys(page.versions!).sort()).toEqual(
      [projects[4], projects[3]].sort(),
    );
    const narrowed = await list({
      account_id: reader,
      max_projects: 2,
      project_id: projects[0],
    });
    expect(narrowed.scope).toEqual([projects[0]]);
    expect(narrowed.entries.length).toBe(1);
    expect(narrowed.too_many_projects).toBe(0);
  });

  test("a catalog without a version is not_ready and hidden until the backfill", async () => {
    const reader = randomUUID();
    const p = await project({ [reader]: "owner" });
    await publish(p, [{ artifact_id: "pre", created_at: 50 }]);
    await getPool().query(
      "DELETE FROM artifact_catalog_project_state WHERE project_id=$1",
      [p],
    );
    const before = await list({ account_id: reader, versions: true });
    expect(before.not_ready).toBe(1);
    expect(before.entries).toEqual([]);
    expect(before.versions).toEqual({});
    await backfillArtifactCatalogProjectState({
      owning_bay_id: bay,
      maxProjects: 10_000,
    });
    const after = await list({ account_id: reader, versions: true });
    expect(after.not_ready).toBe(0);
    expect(after.entries.length).toBe(1);
    expect(Object.keys(after.versions!)).toEqual([p]);
  });

  test("an unreadable and a nonexistent project_id read the same", async () => {
    const reader = randomUUID();
    const theirs = await project({ [stranger]: "owner" });
    await publish(theirs, [{ artifact_id: "t", created_at: 1 }]);
    const strip = ({ scope, ...rest }: any) => ({ ...rest, scope });
    const unreadable = await list({
      account_id: reader,
      project_id: theirs,
      versions: true,
    });
    const missing = await list({
      account_id: reader,
      project_id: randomUUID(),
      versions: true,
    });
    expect(strip(unreadable)).toEqual(strip(missing));
  });
});

// The probe + top-projects page must equal a naive sort of every passing row.
describe("probe optimization equivalence", () => {
  test("random fixtures, views, queries and page sizes", async () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const reader = randomUUID();
    const rows: {
      project_id: string;
      chat_path: string;
      thread_id: string;
      title: string;
      created_at: number;
      entry_id: string;
    }[] = [];
    const projectIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await project({ [reader]: i % 3 ? "owner" : "collaborator" });
      projectIds.push(p);
      for (const chat_path of ["/home/user/a.chat", LIBRARY]) {
        const items: Item[] = [];
        const n = Math.floor(rand() * 15);
        for (let j = 0; j < n; j++) {
          items.push({
            artifact_id: `i${i}-${j}-${chat_path.length}`,
            // Few distinct times, so ties across projects are common.
            created_at: 1000 + Math.floor(rand() * 20),
            thread_id: rand() < 0.5 ? "t-a" : "t-b",
            title: rand() < 0.3 ? `match ${j}` : `other ${j}`,
          });
        }
        if (!items.length) continue;
        const ids = await publish(p, items, chat_path);
        items.forEach((item, k) =>
          rows.push({
            project_id: p,
            chat_path,
            thread_id: item.thread_id!,
            title: item.title!,
            created_at: item.created_at,
            entry_id: ids[k],
          }),
        );
      }
    }
    const mineThreads = projectIds.slice(0, 6).map((project_id) => ({
      project_id,
      source_id: artifactCatalogSourceId({
        project_id,
        chat_path: "/home/user/a.chat",
      }),
      thread_id: "t-a",
    }));
    const naive = (view: "all" | "mine", query?: string) =>
      rows
        .filter(
          (row) =>
            view === "all" ||
            row.chat_path === LIBRARY ||
            mineThreads.some(
              (m) =>
                m.project_id === row.project_id &&
                row.chat_path === "/home/user/a.chat" &&
                m.thread_id === row.thread_id,
            ),
        )
        .filter((row) => !query || row.title.includes(query))
        .sort((a, b) =>
          a.created_at !== b.created_at
            ? b.created_at - a.created_at
            : a.entry_id < b.entry_id
              ? 1
              : -1,
        )
        .map((row) => row.entry_id);
    const mine = {
      source_ids: mineThreads.map((m) => m.source_id),
      thread_ids: mineThreads.map((m) => m.thread_id),
    };
    for (const view of ["all", "mine"] as const)
      for (const query of [undefined, "match"])
        for (const limit of [1, 2, 5, 13, 200]) {
          const got = await walk(
            {
              account_id: reader,
              view,
              ...(view === "mine" ? { mine } : {}),
              ...(query
                ? {
                    query,
                    name_hits: { source_ids: [], thread_ids: [] },
                    alias_hits: { project_ids: [], entry_ids: [] },
                  }
                : {}),
            },
            limit,
          );
          expect(got).toEqual(naive(view, query));
        }
  }, 120_000);
});
