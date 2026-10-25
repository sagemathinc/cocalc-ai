/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  authorizeRead,
  copyToProject,
  ensurePublicDirectorySharesSchema,
} from "./index";
import {
  MIN_AGGREGATE_COUNT,
  __test__,
  deleteShareViewsForAccount,
  getViewAggregates,
  getViews,
  normalizeCountry,
  pruneShareViews,
  recordShareViewNow,
  suppress,
  viewerRole,
} from "./views";

let mockIsAdmin: jest.Mock;
let mockCreateLro: jest.Mock;
// The project's users as its owning bay has them. This bay's projects row has
// none: the share is stored off its project's bay, as for a legacy placement.
let mockProjectUsers: Record<string, { group: string }>;

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: async ({ account_id }) =>
    mockProjectUsers[account_id] ? { users: mockProjectUsers } : null,
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  createLro: (...args: any[]) => mockCreateLro(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  publishLroEvent: jest.fn(async () => undefined),
  publishLroSummary: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/projects/copy-worker", () => ({
  triggerCopyLroWorker: jest.fn(),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  assertCanIncreaseAccountStorage: jest.fn(async () => undefined),
  getProjectOwnerAccountId: jest.fn(async () => null),
  getPublicDirectoryShareLimitForAccount: jest.fn(async () => 100),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => mockIsAdmin(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(async () => []),
  getClusterPublicSharePublisherProfile: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFsClient: jest.fn(),
  getProjectShareFsClient: jest.fn(),
}));

jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: jest.fn(async () => undefined),
}));

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const COLLAB_ID = "77777777-7777-4777-8777-777777777777";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SHARE_ID = "44444444-4444-4444-8444-444444444444";
const USERS = {
  [OWNER_ID]: { group: "owner" },
  [COLLAB_ID]: { group: "collaborator" },
};

function account(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${`${n}`.padStart(12, "0")}`;
}

describe("viewer classification and suppression", () => {
  it("classifies viewers by their group in the project", () => {
    expect(viewerRole("owner")).toBe("owner");
    expect(viewerRole("collaborator")).toBe("collaborator");
    expect(viewerRole("viewer")).toBe("other");
    expect(viewerRole(undefined)).toBe("other");
  });

  it("keeps only real two-letter country codes", () => {
    expect(normalizeCountry("de")).toBe("DE");
    expect(normalizeCountry("XX")).toBeNull();
    expect(normalizeCountry("T1")).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });

  it("suppresses counts made up of fewer than k accounts", () => {
    expect(MIN_AGGREGATE_COUNT).toBe(5);
    expect(suppress({ viewer_days: "9", distinct_viewers: "4" })).toBeNull();
    expect(suppress({ viewer_days: "9", distinct_viewers: "5" })).toEqual({
      viewer_days: 9,
      distinct_viewers: 5,
    });
  });
});

describe("public share views", () => {
  jest.setTimeout(15000);
  const pool = () => getPool();

  beforeAll(async () => {
    await initEphemeralDatabase({ reset: true });
    await ensurePublicDirectorySharesSchema();
    await pool().query(
      `
        INSERT INTO projects (project_id, title, users, last_edited)
        VALUES ($1, 'Shared project', '{}'::jsonb, NOW())
        ON CONFLICT (project_id) DO NOTHING
      `,
      [PROJECT_ID],
    );
    await pool().query(
      `
        INSERT INTO public_project_paths (
          id, project_id, path, slug, visibility, requires_auth,
          availability_status, created_by, updated_by, disabled
        )
        VALUES ($1, $2, 'share', 'views-test', 'unlisted', TRUE, 'available',
                $3, $3, FALSE)
      `,
      [SHARE_ID, PROJECT_ID, OWNER_ID],
    );
    await pool().query(
      `
        INSERT INTO public_project_path_slugs (
          slug_lower, slug, owning_bay_id, public_project_path_id, project_id,
          disabled, updated_at
        )
        VALUES ('views-test', 'views-test', 'bay-0', $1, $2, FALSE, NOW())
      `,
      [SHARE_ID, PROJECT_ID],
    );
  }, 15000);

  beforeEach(async () => {
    mockIsAdmin = jest.fn(async () => false);
    mockProjectUsers = USERS;
    mockCreateLro = jest.fn(async (opts) => ({
      ...opts,
      op_id: "op-1",
    }));
    __test__.resetRecordedCache();
    // (creates the table on the first run)
    await pruneShareViews({ retentionMonths: 0, now: new Date("2100-01-01") });
  });

  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function rows() {
    const { rows } = await pool().query(
      `SELECT account_id, to_char(day, 'YYYY-MM-DD') AS day, viewer_role,
              project_id
         FROM public_share_views ORDER BY day, account_id`,
    );
    return rows;
  }

  async function waitForRows(n: number) {
    for (let i = 0; i < 100; i++) {
      if ((await rows()).length >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error(`expected ${n} rows`);
  }

  function countInserts() {
    const spy = jest.spyOn(pool(), "query");
    spies.push(spy);
    return () =>
      spy.mock.calls.filter(([sql]) =>
        `${sql}`.includes("INSERT INTO public_share_views"),
      ).length;
  }

  const read = (account_id: string, extra = {}) =>
    authorizeRead({
      account_id,
      project_id: PROJECT_ID,
      share_id: SHARE_ID,
      ...extra,
    });

  it("records a read once per account and day, with the viewer's role", async () => {
    await read(VIEWER_ID);
    await waitForRows(1);
    const inserts = countInserts();
    await read(VIEWER_ID);
    await read(VIEWER_ID);
    expect(inserts()).toBe(0);
    await read(OWNER_ID);
    await waitForRows(2);
    expect((await rows()).map((r) => [r.account_id, r.viewer_role])).toEqual(
      expect.arrayContaining([
        [VIEWER_ID, "other"],
        [OWNER_ID, "owner"],
      ]),
    );
    expect((await rows())[0].project_id).toBe(PROJECT_ID);
  });

  it("writes nothing more when another process already recorded today", async () => {
    const now = new Date("2026-10-25T10:00:00Z");
    const opts = {
      share_id: SHARE_ID,
      project_id: PROJECT_ID,
      account_id: VIEWER_ID,
      project_users: USERS,
      now,
    };
    await recordShareViewNow(opts);
    __test__.resetRecordedCache();
    await recordShareViewNow({
      ...opts,
      now: new Date("2026-10-25T23:00:00Z"),
    });
    await recordShareViewNow({
      ...opts,
      now: new Date("2026-10-26T01:00:00Z"),
    });
    expect((await rows()).map((r) => r.day)).toEqual([
      "2026-10-25",
      "2026-10-26",
    ]);
  });

  it("takes the viewer's role from the project's bay, not this bay's projects row", async () => {
    for (const account_id of [OWNER_ID, COLLAB_ID, VIEWER_ID]) {
      await recordShareViewNow({
        share_id: SHARE_ID,
        project_id: PROJECT_ID,
        account_id,
      });
    }
    expect((await rows()).map((r) => [r.account_id, r.viewer_role])).toEqual(
      expect.arrayContaining([
        [OWNER_ID, "owner"],
        [COLLAB_ID, "collaborator"],
        [VIEWER_ID, "other"],
      ]),
    );
  });

  const copy = (account_id: string) =>
    copyToProject({
      account_id,
      slug: "views-test",
      path: "a.txt",
      destination_project_id: PROJECT_ID,
    });

  it("records a copy once it is queued", async () => {
    await copy(VIEWER_ID);
    expect(mockCreateLro).toHaveBeenCalled();
    await waitForRows(1);
    expect((await rows())[0]).toMatchObject({
      account_id: VIEWER_ID,
      viewer_role: "other",
    });
  });

  it("does not record a copy that could not be queued", async () => {
    mockCreateLro = jest.fn(async () => {
      throw Error("could not queue");
    });
    await expect(copy(VIEWER_ID)).rejects.toThrow("could not queue");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rows()).toEqual([]);
  });

  it("does not record a check that is not a read", async () => {
    const inserts = countInserts();
    await read(VIEWER_ID, { record_view: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inserts()).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("never fails or blocks a read when recording fails, and tries again later", async () => {
    const query = pool().query.bind(pool());
    const spy = jest
      .spyOn(pool(), "query")
      .mockImplementation(((sql: any, ...args: any[]) =>
        `${sql}`.includes("INSERT INTO public_share_views")
          ? Promise.reject(new Error("database is down"))
          : query(sql, ...args)) as any);
    await expect(read(VIEWER_ID)).resolves.toMatchObject({
      share_id: SHARE_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    spy.mockRestore();
    expect(await rows()).toEqual([]);
    await read(VIEWER_ID);
    await waitForRows(1);
  });

  it("shows a share's owners counts by role, never other viewers' identities", async () => {
    const now = new Date("2026-10-25T12:00:00Z");
    for (const [account_id, day] of [
      [VIEWER_ID, "2026-10-24T08:00:00Z"],
      [VIEWER_ID, "2026-10-25T08:00:00Z"],
      [OWNER_ID, "2026-10-25T09:00:00Z"],
      [COLLAB_ID, "2026-10-25T09:00:00Z"],
      [account(1), "2026-10-25T09:00:00Z"],
    ]) {
      await recordShareViewNow({
        share_id: SHARE_ID,
        project_id: PROJECT_ID,
        account_id,
        now: new Date(day),
      });
    }
    const views = await getViews({
      account_id: COLLAB_ID,
      project_id: PROJECT_ID,
      share_id: SHARE_ID,
      days: 7,
      now,
    });
    expect(views).toEqual({
      project_id: PROJECT_ID,
      share_id: SHARE_ID,
      since: "2026-10-19",
      by_day: [
        {
          day: "2026-10-24",
          viewers: 1,
          owner: 0,
          collaborator: 0,
          other: 1,
        },
        {
          day: "2026-10-25",
          viewers: 4,
          owner: 1,
          collaborator: 1,
          other: 2,
        },
      ],
      distinct_viewers: { viewers: 4, owner: 1, collaborator: 1, other: 2 },
    });
    expect(JSON.stringify(views)).not.toContain(VIEWER_ID);
    await expect(
      getViews({
        account_id: VIEWER_ID,
        project_id: PROJECT_ID,
        share_id: SHARE_ID,
        now,
      }),
    ).rejects.toThrow("public directory share not found");
  });

  it("gives admins only aggregates, leaving out anything under k accounts", async () => {
    const now = new Date("2026-10-25T12:00:00Z");
    for (let n = 0; n < MIN_AGGREGATE_COUNT; n++) {
      await recordShareViewNow({
        share_id: SHARE_ID,
        project_id: PROJECT_ID,
        account_id: account(n),
        country: n < MIN_AGGREGATE_COUNT - 1 ? "DE" : null,
        now,
      });
    }
    // a single viewer on another day
    await recordShareViewNow({
      share_id: SHARE_ID,
      project_id: PROJECT_ID,
      account_id: account(99),
      country: "FR",
      now: new Date("2026-10-23T12:00:00Z"),
    });
    await expect(
      getViewAggregates({ account_id: VIEWER_ID, now }),
    ).rejects.toThrow("must be an admin");
    mockIsAdmin = jest.fn(async () => true);
    const report = await getViewAggregates({
      account_id: VIEWER_ID,
      project_id: PROJECT_ID,
      share_id: SHARE_ID,
      now,
    });
    // all shares on this bay: the same here
    expect(await getViewAggregates({ account_id: VIEWER_ID, now })).toEqual(
      report,
    );
    // a share this bay doesn't store, so the caller tries other bays
    await expect(
      getViewAggregates({
        account_id: VIEWER_ID,
        project_id: PROJECT_ID,
        share_id: COLLAB_ID,
        now,
      }),
    ).rejects.toThrow("public directory share not found");
    expect(report.totals).toEqual({
      viewer_days: MIN_AGGREGATE_COUNT + 1,
      distinct_viewers: MIN_AGGREGATE_COUNT + 1,
    });
    // 2026-10-23 had one viewer: not listed at all
    expect(report.by_day).toEqual([
      {
        day: "2026-10-25",
        viewer_days: MIN_AGGREGATE_COUNT,
        distinct_viewers: MIN_AGGREGATE_COUNT,
      },
    ]);
    // 4 in DE, 1 unknown, 1 in FR: each too small, so no country shows
    expect(report.by_country).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("DE");
    expect(JSON.stringify(report)).not.toContain("FR");
    expect(JSON.stringify(report)).not.toContain("2026-10-23");
    // and too few in all: no totals either
    expect(
      (
        await getViewAggregates({
          account_id: VIEWER_ID,
          viewer_role: "other",
          days: 2,
          now: new Date("2026-10-24T12:00:00Z"),
        })
      ).totals,
    ).toBeNull();
    expect(JSON.stringify(report)).not.toContain(account(0));
  });

  it("deletes views older than the retention period", async () => {
    for (const day of [
      "2025-09-24",
      "2025-09-26",
      "2025-02-27",
      "2025-02-28",
      "2025-03-01",
    ]) {
      await recordShareViewNow({
        share_id: SHARE_ID,
        project_id: PROJECT_ID,
        account_id: VIEWER_ID,
        now: new Date(`${day}T12:00:00Z`),
      });
    }
    // 2026-03-31 minus 13 months is 2025-02-28, not 2025-03-03
    expect(
      await pruneShareViews({ now: new Date("2026-03-31T12:00:00Z") }),
    ).toBe(1);
    expect((await rows()).map((r) => r.day)).toEqual([
      "2025-02-28",
      "2025-03-01",
      "2025-09-24",
      "2025-09-26",
    ]);
    expect(
      await pruneShareViews({ now: new Date("2026-10-25T12:00:00Z") }),
    ).toBe(3);
    expect((await rows()).map((r) => r.day)).toEqual(["2025-09-26"]);
  });

  it("finds a share's days and an account's views by index", async () => {
    const { rows } = await pool().query(
      "SELECT indexdef FROM pg_indexes WHERE tablename='public_share_views'",
    );
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(defs).toMatch(/\(share_id, day, account_id\)/);
    expect(defs).toMatch(/\(account_id\)/);
    expect(defs).toMatch(/\(day\)/);
  });

  it("deletes a deleted account's views", async () => {
    for (const account_id of [VIEWER_ID, OWNER_ID, COLLAB_ID]) {
      await recordShareViewNow({
        share_id: SHARE_ID,
        project_id: PROJECT_ID,
        account_id,
      });
    }
    expect(await deleteShareViewsForAccount(VIEWER_ID)).toBe(1);
    // and the retention loop deletes any of an account deleted on this bay
    await pool().query(
      `INSERT INTO accounts (account_id, deleted) VALUES ($1, TRUE)
       ON CONFLICT (account_id) DO UPDATE SET deleted=TRUE`,
      [COLLAB_ID],
    );
    expect(await pruneShareViews()).toBe(1);
    expect((await rows()).map((r) => r.account_id)).toEqual([OWNER_ID]);
  });
});
