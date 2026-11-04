import { randomUUID } from "node:crypto";
import {
  ARTIFACT_CATALOG_DEFAULT_VIEW,
  capabilities,
  listAccount,
  listAccountHomeControl,
  listAccountOnHomeBay,
  listAccountOwnedControl,
  resetArtifactCatalogCapabilitiesForTests,
  validateArtifactCatalogListRequest,
} from "./catalog-list";
import {
  ARTIFACT_CATALOG_READ_LIMITED,
  resetArtifactCatalogReadLimitsForTests,
} from "./catalog-read-limits";
import { artifactCatalogSourceId } from "@cocalc/database/postgres/artifact-catalog";

let banned = false;
let homeBay = "here";
const projection: { bay_id: string; projects: number }[] = [];
let namedRows: any[] = [];
let aliasRows: any[] = [];
const queries: { sql: string; params: any[] }[] = [];
const ownerRead = jest.fn();
const authorized = jest.fn();
const backfillRemaining = jest.fn();
const resolveProjectBay = jest.fn();
const remote = { listAccountHome: jest.fn(), listAccountOwned: jest.fn() };
const remoteClient = jest.fn((_opts?: any) => remote);
const mismatch = { inc: jest.fn() };

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "here",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async ({ account_id }) => ({
    account_id,
    home_bay_id: homeBay,
  }),
}));
// A client-supplied project id must never choose a destination.
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => resolveProjectBay(...a),
  resolveProjectBays: (...a) => resolveProjectBay(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted-fabric",
}));
jest.mock("@cocalc/conat/inter-bay/artifact-catalog", () => ({
  createInterBayArtifactCatalogClient: (o) => remoteClient(o),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => banned,
}));
jest.mock("@cocalc/backend/metrics", () => ({
  newCounter: () => mismatch,
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM account_project_index"))
        return { rows: projection };
      if (sql.includes("FROM agent_personal_names"))
        return { rows: namedRows.slice(0, params[3]) };
      if (sql.includes("FROM personal_library_aliases"))
        return { rows: aliasRows.slice(0, params[2]) };
      throw Error(`unexpected query: ${sql}`);
    },
  }),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog", () => ({
  ...jest.requireActual("@cocalc/database/postgres/artifact-catalog"),
  artifactCatalogStateBackfillRemaining: (...a) => backfillRemaining(...a),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog-list", () => ({
  ...jest.requireActual("@cocalc/database/postgres/artifact-catalog-list"),
  listArtifactCatalogForAccountLocal: (...a) => ownerRead(...a),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog-read", () => ({
  ARTIFACT_CATALOG_NOT_PERMITTED: "not found or not permitted",
  ARTIFACT_CATALOG_READ_GROUPS: ["owner", "collaborator"],
  authorizedArtifactCatalogProjects: (...a) => authorized(...a),
}));

const account_id = randomUUID();
const hex = (n: number) => n.toString(16).padStart(64, "0");

/** n entries with created_ms start, start-1, ... in one project. */
function ownedReply(
  project_id: string,
  start: number,
  n: number,
  extra: Partial<any> = {},
) {
  const entries = Array.from({ length: n }, (_, i) => ({
    entry_id: hex(start * 1000 + i),
    project_id,
    chat_path: "/c.chat",
    item: {},
  }));
  return {
    entries,
    keys: entries.map((e, i) => `${start - i}:${e.entry_id}`),
    more: false,
    authorized: 1,
    too_many_projects: 0,
    not_ready: 0,
    ...extra,
  };
}

const request = (opts: any = {}) =>
  validateArtifactCatalogListRequest({ account_id, ...opts });

beforeEach(() => {
  jest.clearAllMocks();
  resetArtifactCatalogReadLimitsForTests();
  resetArtifactCatalogCapabilitiesForTests();
  banned = false;
  homeBay = "here";
  projection.length = 0;
  namedRows = [];
  aliasRows = [];
  queries.length = 0;
  authorized.mockImplementation(
    async (_db, { project_ids }) => new Set(project_ids),
  );
});

describe("merging owner bays (M1)", () => {
  test("next is set when the merge truncates, even with no bay reporting more", async () => {
    projection.push(
      { bay_id: "bay-a", projects: 1 },
      { bay_id: "bay-b", projects: 1 },
    );
    const call = jest.fn(async (bay_id: string) =>
      bay_id === "bay-a"
        ? ownedReply(randomUUID(), 1000, 40)
        : bay_id === "bay-b"
          ? ownedReply(randomUUID(), 999, 40)
          : ownedReply(randomUUID(), 0, 0, { authorized: 0 }),
    );
    const page = await listAccountOnHomeBay(request({ limit: 50 }), call);
    expect(page.entries).toHaveLength(50);
    expect(page.next).toBeDefined();
    // Newest first across bays: 1000(a), 999(a), 999(b), 998(a), 998(b), ...
    const keys = page.entries.map((e) => e.entry_id);
    expect(new Set(keys).size).toBe(50);
    expect(page.next).toBe(`975:${page.entries[49].entry_id}`);
  });

  test("no next when every candidate fits and no bay has more", async () => {
    projection.push(
      { bay_id: "bay-a", projects: 1 },
      { bay_id: "bay-b", projects: 1 },
    );
    const call = jest.fn(async (bay_id: string) =>
      bay_id === "here"
        ? ownedReply(randomUUID(), 0, 0)
        : ownedReply(randomUUID(), bay_id === "bay-a" ? 500 : 400, 20),
    );
    const page = await listAccountOnHomeBay(request({ limit: 50 }), call);
    expect(page.entries).toHaveLength(40);
    expect(page.next).toBeUndefined();
  });

  test("a bay with more rows sets next even when the merge fits", async () => {
    const call = jest.fn(async () =>
      ownedReply(randomUUID(), 100, 5, { more: true }),
    );
    const page = await listAccountOnHomeBay(request({ limit: 5 }), call);
    expect(page.next).toBe(`96:${page.entries[4].entry_id}`);
  });
});

describe("fan-out (D2) and routing (D1)", () => {
  test("every projected bay is asked, at most 8 at once; failures count as unavailable", async () => {
    for (let i = 0; i < 9; i++)
      projection.push({ bay_id: `bay-${i}`, projects: 1 });
    let inFlight = 0,
      maxInFlight = 0;
    const call = jest.fn(async (bay_id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (bay_id === "bay-3") throw Error("down");
      if (bay_id === "bay-4") return { entries: [{}], keys: [] } as any;
      return ownedReply(randomUUID(), 10, 1);
    });
    const page = await listAccountOnHomeBay(request(), call);
    expect(call.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...projection.map((p) => p.bay_id), "here"].sort(),
    );
    expect(maxInFlight).toBe(8);
    expect(page.incomplete).toEqual({ unavailable_bays: 2 });
  });

  test("a project_id never chooses the destination: same bays, no resolver, same reply", async () => {
    projection.push({ bay_id: "bay-a", projects: 2 });
    const empty = () =>
      ownedReply(randomUUID(), 0, 0, { authorized: 0, versions: {} });
    const call = jest.fn(async () => empty());
    const unreadable = await listAccountOnHomeBay(
      request({ project_id: randomUUID(), versions: true }),
      call,
    );
    const firstBays = call.mock.calls.map((c) => c[0]).sort();
    call.mockClear();
    const nonexistent = await listAccountOnHomeBay(
      request({ project_id: randomUUID(), versions: true }),
      call,
    );
    expect(call.mock.calls.map((c) => c[0]).sort()).toEqual(firstBays);
    expect(firstBays).toEqual(["bay-a", "here"]);
    expect(JSON.stringify(unreadable)).toBe(JSON.stringify(nonexistent));
    expect(unreadable).toEqual({
      entries: [],
      view: ARTIFACT_CATALOG_DEFAULT_VIEW,
      versions: {},
    });
    expect(resolveProjectBay).not.toHaveBeenCalled();
    // Narrowed reads never count as a stale projection.
    expect(mismatch.inc).not.toHaveBeenCalled();
  });

  test("a projected bay with no readable project is counted (D4), counts only", async () => {
    projection.push({ bay_id: "bay-a", projects: 3 });
    const call = jest.fn(async () =>
      ownedReply(randomUUID(), 0, 0, { authorized: 0 }),
    );
    await listAccountOnHomeBay(request(), call);
    // bay-a lists 3 projects but authorized none; "here" lists none.
    expect(mismatch.inc).toHaveBeenCalledTimes(1);
    expect(mismatch.inc).toHaveBeenCalledWith();
  });

  test("the hub forwards to the account's home bay", async () => {
    homeBay = "home-elsewhere";
    remote.listAccountHome.mockResolvedValue({ entries: [], view: "all" });
    await listAccount({ account_id, view: "all", limit: 7 });
    expect(remoteClient).toHaveBeenCalledWith({
      client: "trusted-fabric",
      bay_id: "home-elsewhere",
    });
    expect(remote.listAccountHome).toHaveBeenCalledWith({
      account_id,
      limit: 7,
      view: "all",
      versions: false,
      home_bay_id: "home-elsewhere",
    });
  });

  test("a request that arrives at a stale home is refused", async () => {
    homeBay = "moved";
    await expect(
      listAccountHomeControl({ account_id, home_bay_id: "here" }),
    ).rejects.toThrow("stale account-home route");
    homeBay = "here";
    await expect(
      listAccountHomeControl({ account_id, home_bay_id: "other" }),
    ).rejects.toThrow("stale account-home route");
  });

  test("a banned account is refused before any owner bay is asked", async () => {
    banned = true;
    const call = jest.fn();
    await expect(listAccountOnHomeBay(request(), call)).rejects.toThrow(
      "not found or not permitted",
    );
    expect(call).not.toHaveBeenCalled();
  });
});

describe("filters from the requester's own data", () => {
  test("mine is the default view and uses the catalog's source key", async () => {
    const project_id = randomUUID();
    namedRows = [{ project_id, path: "/home/user/a.chat", thread_id: "t1" }];
    const call = jest.fn(async () => ownedReply(project_id, 0, 0));
    const page = await listAccountOnHomeBay(request(), call);
    expect(page.view).toBe("mine");
    expect(call.mock.calls[0][1].mine).toEqual({
      source_ids: [
        artifactCatalogSourceId({ project_id, chat_path: "/home/user/a.chat" }),
      ],
      thread_ids: ["t1"],
    });
    const sql = queries.find((q) => q.sql.includes("agent_personal_names"))!;
    expect(sql.params[0]).toBe(account_id);
    expect(sql.sql).toContain("retired_at IS NULL");
  });

  test("filter lists are read with cap + 1: limited only when larger than the cap", async () => {
    const row = () => ({
      project_id: randomUUID(),
      path: "/a.chat",
      thread_id: "t",
    });
    const call = jest.fn(async () => ownedReply(randomUUID(), 0, 0));
    namedRows = Array.from({ length: 500 }, row);
    expect(
      (await listAccountOnHomeBay(request(), call)).limited,
    ).toBeUndefined();
    namedRows = Array.from({ length: 501 }, row);
    const page = await listAccountOnHomeBay(request(), call);
    expect(page.limited).toEqual({ named_agents: true });
    expect(call.mock.calls.at(-1)![1].mine.source_ids).toHaveLength(500);
    aliasRows = Array.from({ length: 501 }, () => ({
      project_id: randomUUID(),
      entry_id: "e".repeat(64),
    }));
    namedRows = [];
    const search = await listAccountOnHomeBay(
      request({ view: "all", query: "x" }),
      call,
    );
    expect(search.limited).toEqual({ aliases: true });
    expect(call.mock.calls.at(-1)![1].alias_hits.entry_ids).toHaveLength(500);
  });

  test("search sends escaped name and alias matches and the Library-name hit", async () => {
    const call = jest.fn(async () => ownedReply(randomUUID(), 0, 0));
    await listAccountOnHomeBay(
      request({ view: "all", query: " Art%_ " }),
      call,
    );
    const alias = queries.find((q) =>
      q.sql.includes("personal_library_aliases"),
    )!;
    expect(alias.params[1]).toBe("%Art\\%\\_%");
    expect(call.mock.calls[0][1].library_name_hit).toBe(false);
    await listAccountOnHomeBay(request({ view: "all", query: "ART" }), call);
    expect(call.mock.calls.at(-1)![1]).toMatchObject({
      query: "ART",
      library_name_hit: true,
    });
  });
});

describe("rate limits (per hub process)", () => {
  test("a query takes the search limit in addition to the page limit", async () => {
    const call = remote.listAccountHome;
    homeBay = "elsewhere";
    call.mockResolvedValue({ entries: [], view: "all" });
    for (let i = 0; i < 10; i++)
      await listAccount({ account_id, query: "q", view: "all" });
    await expect(
      listAccount({ account_id, query: "q", view: "all" }),
    ).rejects.toThrow(ARTIFACT_CATALOG_READ_LIMITED);
    // Pages without a query still have their own budget.
    await listAccount({ account_id, view: "all" });
  });

  test("probes have their own budget, and a probe with a query takes both", async () => {
    homeBay = "elsewhere";
    remote.listAccountHome.mockResolvedValue({ entries: [], view: "all" });
    for (let i = 0; i < 6; i++) await listAccount({ account_id, limit: 0 });
    await expect(listAccount({ account_id, limit: 0 })).rejects.toThrow(
      ARTIFACT_CATALOG_READ_LIMITED,
    );
    resetArtifactCatalogReadLimitsForTests();
    for (let i = 0; i < 10; i++)
      await listAccount({ account_id, query: "q", view: "all" });
    await expect(
      listAccount({ account_id, limit: 0, query: "q" }),
    ).rejects.toThrow(ARTIFACT_CATALOG_READ_LIMITED);
  });

  test("the whole request is validated before any limit or routing", async () => {
    for (const bad of [
      { limit: 201 },
      { before: "01:" + "a".repeat(64) },
      { query: "q".repeat(201) },
      { project_id: "nope" },
      { view: "everything" },
    ])
      await expect(
        listAccount({ account_id, ...(bad as any) }),
      ).rejects.toThrow();
    expect(remoteClient).not.toHaveBeenCalled();
  });
});

describe("owner bay", () => {
  test("re-checks after the read and drops a revoked project from rows and versions", async () => {
    const kept = randomUUID();
    const revoked = randomUUID();
    ownerRead.mockResolvedValue({
      entries: [
        { entry_id: hex(1), project_id: kept, chat_path: "/c", item: {} },
        { entry_id: hex(2), project_id: revoked, chat_path: "/c", item: {} },
      ],
      keys: [`2:${hex(1)}`, `1:${hex(2)}`],
      more: false,
      versions: {
        [kept]: { epoch: "e", seq: 1 },
        [revoked]: { epoch: "e", seq: 2 },
      },
      scope: [kept, revoked],
      authorized: 2,
      too_many_projects: 0,
      not_ready: 0,
    });
    authorized.mockResolvedValue(new Set([kept]));
    const reply = await listAccountOwnedControl({
      account_id,
      limit: 5,
      view: "all",
      versions: true,
    });
    expect(reply.entries.map((e) => e.project_id)).toEqual([kept]);
    expect(reply.keys).toEqual([`2:${hex(1)}`]);
    expect(Object.keys(reply.versions!)).toEqual([kept]);
    expect(authorized).toHaveBeenCalledWith(expect.anything(), {
      account_id,
      owning_bay_id: "here",
      project_ids: [kept, revoked],
    });
    // The owning bay comes from configuration, never from the request.
    expect(ownerRead.mock.calls[0][0].owning_bay_id).toBe("here");
    expect(ownerRead.mock.calls[0][0].max_projects).toBeUndefined();
  });

  test("a banned account gets the uniform error", async () => {
    banned = true;
    await expect(
      listAccountOwnedControl({ account_id, limit: 5, view: "all" }),
    ).rejects.toThrow("not found or not permitted");
    expect(ownerRead).not.toHaveBeenCalled();
  });
});

describe("capabilities", () => {
  test("list is advertised only once this bay's version backfill is complete", async () => {
    backfillRemaining.mockResolvedValue(3);
    expect(await capabilities({ account_id })).toEqual({
      list: 0,
      deltas: 0,
      hints: 0,
    });
    resetArtifactCatalogCapabilitiesForTests();
    backfillRemaining.mockResolvedValue(0);
    expect((await capabilities({ account_id })).list).toBe(1);
    expect(backfillRemaining).toHaveBeenLastCalledWith("here");
    // Cached: no second count within the TTL.
    await capabilities({ account_id });
    expect(backfillRemaining).toHaveBeenCalledTimes(2);
  });
});
