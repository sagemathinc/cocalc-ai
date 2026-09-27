import type { PoolClient } from "../pool";
import type { CollaborationNotificationDelivery } from "@cocalc/util/collaboration-attention";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { SCHEMA } from "@cocalc/util/schema";
import { syncSchema } from "./schema";
import {
  assertProjectNotRehoming,
  ProjectRehomeInProgressError,
} from "./project-rehome-fence";
import {
  appendCollaborationNotificationEvents,
  ensureCollaborationNotificationSchema,
  initializeCollaborationProjectionAttention,
  collaborationNotificationStore,
  lockCollaborationNotificationAttention,
  readCollaborationNotificationPage,
  readCollaborationNotificationAttention,
  pruneCollaborationNotificationEvents,
} from "./collaborators-notifications";

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockDb = {
  query: mockQuery,
  release: mockRelease,
} as unknown as PoolClient;
jest.mock("../pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery, connect: async () => mockDb }),
}));
jest.mock("./account-rehome-fence", () => ({
  withAccountRehomeWriteFence: async ({ fn }) => fn(mockDb),
}));
jest.mock("./collaborators-account-maintenance", () => ({
  lockCollaborationMaintenanceAccounts: async (_db, ids) => new Set(ids),
}));
jest.mock("./project-rehome-fence", () => ({
  assertProjectNotRehoming: jest.fn(),
  ProjectRehomeInProgressError: class extends Error {},
}));
jest.mock("./schema", () => ({ syncSchema: jest.fn() }));

const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const generation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const job = {
  account_id,
  project_id,
  generation,
  cursor: "1",
  claim_id: account_id,
  grant_request_id: account_id,
};
const delivery: CollaborationNotificationDelivery = {
  account_id,
  access_generation: generation,
  grant_request_id: account_id,
  event: {
    version: 1,
    project_id,
    room_id: generation,
    thread_id: "thread",
    message_id: "message",
    actor_account_id: project_id,
    activity: 2,
    mode: "live",
    mentioned_account_ids: [account_id],
    mention_all: false,
  },
};
const resource: CollaborationResource = {
  project_id,
  kind: "conversation",
  resource_id: "thread",
  thread_id: "thread",
  chat_path: "/home/user/room.chat",
  title: "Discussion",
  participant_ids: [account_id],
  created_at: 0,
  updated_at: 0,
  activity: 7,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
});

it("synchronizes the canonical schema rather than maintaining runtime table DDL", async () => {
  await ensureCollaborationNotificationSchema();
  expect(syncSchema).toHaveBeenCalledWith({
    collaboration_notification_events: SCHEMA.collaboration_notification_events,
    collaboration_notification_floors: SCHEMA.collaboration_notification_floors,
    collaboration_notification_cursors:
      SCHEMA.collaboration_notification_cursors,
    collaboration_personal: SCHEMA.collaboration_personal,
  });
  expect(mockQuery).not.toHaveBeenCalled();
});

it("bounds projection initialization and rejects wrong-project resources before SQL", async () => {
  const options = { account_id, project_id, generation, resources: [resource] };
  await expect(
    initializeCollaborationProjectionAttention(mockDb, {
      ...options,
      resources: Array(51).fill(resource),
    }),
  ).rejects.toThrow("capacity");
  await expect(
    initializeCollaborationProjectionAttention(mockDb, {
      ...options,
      resources: [{ ...resource, project_id: account_id }],
    }),
  ).rejects.toThrow("project mismatch");
  await expect(
    initializeCollaborationProjectionAttention(mockDb, {
      ...options,
      resources: [resource, resource],
    }),
  ).rejects.toThrow("duplicate");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("derives initialization floors from the recipient's persisted cutover, not project generation", async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [{ epoch: account_id, notification_position: "100" }],
  });
  mockQuery.mockResolvedValueOnce({
    rows: [{ thread_id: resource.thread_id, activity: "6" }],
  });
  expect(
    await readCollaborationNotificationAttention(mockDb, {
      project_id,
      account_id,
      resources: [resource],
    }),
  ).toEqual({ generation: account_id, floors: { thread: 5 } });
  expect(mockQuery.mock.calls[1][1]).toEqual([
    project_id,
    "100",
    [resource.thread_id],
  ]);
  expect(mockQuery.mock.calls[1][0]).toContain("position>$2::bigint");
  expect(mockQuery.mock.calls[1][0]).not.toContain("generation=");
});

it("marks history as read when there is no post-cutover live message", async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [{ epoch: account_id, notification_position: "100" }],
  });
  expect(
    await readCollaborationNotificationAttention(mockDb, {
      project_id,
      account_id,
      resources: [resource],
    }),
  ).toEqual({ generation: account_id, floors: { thread: 7 } });
});

it("initializes human attention under the caller's transaction without subscribing participants", async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{}] })
    .mockResolvedValueOnce({ rowCount: 1 });
  expect(
    await initializeCollaborationProjectionAttention(mockDb, {
      account_id,
      project_id,
      generation,
      resources: [resource],
    }),
  ).toBe(1);
  expect(mockQuery.mock.calls[0][0]).toContain("FOR UPDATE");
  const [sql, parameters] = mockQuery.mock.calls[1];
  expect(JSON.parse(parameters[3])).toEqual([
    {
      entry_key: expect.any(String),
      activity: 7,
      following: false,
      muted: false,
    },
  ]);
  expect(sql).toContain("GREATEST(p.read_through,excluded.read_through)");
  expect(sql).toContain(
    "p.attention_generation IS DISTINCT FROM excluded.attention_generation",
  );
  expect(
    mockQuery.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)),
  ).toBe(false);
});

it("does not initialize agent/artifact attention or write without an access row", async () => {
  const options = { account_id, project_id, generation, resources: [resource] };
  expect(
    await initializeCollaborationProjectionAttention(mockDb, {
      ...options,
      resources: [{ ...resource, kind: "agent" }],
    }),
  ).toBe(0);
  expect(mockQuery).not.toHaveBeenCalled();
  await expect(
    initializeCollaborationProjectionAttention(mockDb, options),
  ).rejects.toThrow("not ready");
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

it("bounds claims before database access and keeps the explicit home bay in the claim query", async () => {
  const store = collaborationNotificationStore(jest.fn(), "home-bay");
  await expect(store.claim(9)).rejects.toThrow("limit");
  expect(
    mockQuery.mock.calls.some(([sql]) =>
      sql.includes("FOR UPDATE OF c SKIP LOCKED"),
    ),
  ).toBe(false);
  mockQuery.mockClear();
  mockQuery.mockImplementation(async (sql) => ({
    rows: sql.includes("SELECT cursor FROM collaboration_maintenance")
      ? [{ cursor: {} }]
      : sql.includes("due_at::text AS due_at_key")
        ? [
            {
              account_id,
              project_id,
              due_at_key: "2026-01-01 00:00:00.123456+00",
            },
          ]
        : [],
  }));
  await store.claim(8);
  const claim = mockQuery.mock.calls.find(([sql]) =>
    sql.includes("FOR UPDATE OF c SKIP LOCKED"),
  );
  expect(claim?.[1]).toEqual(["home-bay", expect.any(String), 8]);
  expect(
    mockQuery.mock.calls.find(([sql]) => sql.includes("LIMIT 64"))?.[1]?.[0],
  ).toBe("home-bay");
  expect(mockRelease).toHaveBeenCalled();
});

it("sanitizes durable retry errors and fences retry updates with the claim id", async () => {
  const store = collaborationNotificationStore(jest.fn(), "home-bay");
  await store.fail(job, Error("private message body or credential"));
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("claim_id=$3"),
    [account_id, project_id, job.claim_id, "home-bay"],
  );
  expect(JSON.stringify(mockQuery.mock.calls)).not.toContain("credential");
});

it("acknowledges only the exact claim, generation and old cursor", async () => {
  mockQuery.mockImplementation(async (sql) => {
    if (sql.includes("SELECT generation,granted_generation,grant_request_id"))
      return {
        rows: [
          {
            generation,
            granted_generation: generation,
            grant_request_id: account_id,
          },
        ],
      };
    if (sql.includes("lease_until>clock_timestamp()")) return { rows: [{}] };
    return { rows: [] };
  });
  const store = collaborationNotificationStore(jest.fn(), "home-bay");
  expect(
    await store.acknowledge(job, {
      allowed: true,
      generation,
      access_generation: generation,
      cursor: "2",
      complete: true,
      reset: false,
      entries: [],
    }),
  ).toBe(false);
  const update = mockQuery.mock.calls.find(([sql]) =>
    sql.includes("UPDATE collaboration_notification_cursors"),
  );
  expect(update?.[0]).toContain("generation IS NOT DISTINCT FROM $4::uuid");
  expect(update?.[0]).toContain("cursor IS NOT DISTINCT FROM $5::text");
  expect(update?.[1].slice(0, 5)).toEqual([
    account_id,
    project_id,
    job.claim_id,
    generation,
    "1",
  ]);
});

it("does not advance a cursor when the account projection is behind owner generation", async () => {
  const store = collaborationNotificationStore(jest.fn(), "home-bay");
  await expect(
    store.acknowledge(job, {
      allowed: true,
      generation,
      access_generation: generation,
      cursor: "2",
      complete: true,
      reset: true,
      entries: [],
    }),
  ).rejects.toThrow("not ready");
  expect(
    mockQuery.mock.calls.some(([sql]) =>
      sql.includes("UPDATE collaboration_notification_cursors"),
    ),
  ).toBe(false);
});

it("owner page reads fail closed on the wrong authority and reject malformed cursors", async () => {
  await expect(
    readCollaborationNotificationPage(job, { owning_bay_id: "wrong-bay" }),
  ).rejects.toThrow("owner unavailable");
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("p.owning_bay_id=$2"),
    [project_id, "wrong-bay"],
  );
  await expect(
    readCollaborationNotificationPage(
      { ...job, cursor: "-1" },
      { owning_bay_id: "owner" },
    ),
  ).rejects.toThrow("cursor");
});

it("does not advance owner notification state during a project handoff", async () => {
  jest
    .mocked(assertProjectNotRehoming)
    .mockRejectedValueOnce(new ProjectRehomeInProgressError("handoff frozen"));
  await expect(
    readCollaborationNotificationPage(job, { owning_bay_id: "owner" }),
  ).rejects.toThrow("handoff frozen");
  expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN",
    "ROLLBACK",
  ]);
});

it("does not append notification intent behind the source handoff fence", async () => {
  jest
    .mocked(assertProjectNotRehoming)
    .mockRejectedValueOnce(new ProjectRehomeInProgressError("handoff frozen"));
  await expect(
    appendCollaborationNotificationEvents(
      mockDb,
      {
        project_id,
        chat_path: "/home/user/room.chat",
        epoch: generation,
        sequence: 1,
        resources: [resource],
        notification_events: [delivery.event],
      },
      { owning_bay_id: "owner", host_id: account_id },
    ),
  ).rejects.toThrow("handoff frozen");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("skips retained events of a frozen project during bounded pruning", async () => {
  mockQuery.mockImplementation(async (sql) => ({
    rows: sql.includes("GROUP BY e.project_id") ? [{ project_id }] : [],
  }));
  jest
    .mocked(assertProjectNotRehoming)
    .mockRejectedValueOnce(new ProjectRehomeInProgressError("handoff frozen"));
  await expect(pruneCollaborationNotificationEvents("owner")).resolves.toBe(0);
  expect(
    mockQuery.mock.calls.some(([sql]) =>
      sql.includes("DELETE FROM collaboration_notification_events"),
    ),
  ).toBe(false);
  expect(
    mockQuery.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO collaboration_notification_floors"),
    ),
  ).toBe(false);
});

it("attention locks access before any personal write and rejects a removed generation", async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        generation: "another-membership",
        granted_generation: "another-membership",
        grant_request_id: account_id,
      },
    ],
  });
  await expect(
    lockCollaborationNotificationAttention({ db: mockDb, delivery }),
  ).rejects.toThrow("not ready");
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQuery.mock.calls[0][0]).toContain("FOR UPDATE");
});

it.each([null, project_id])(
  "rejects granted generation %s even while indexed generation matches",
  async (granted_generation) => {
    mockQuery.mockResolvedValue({
      rows: [{ generation, granted_generation, grant_request_id: account_id }],
    });
    await expect(
      lockCollaborationNotificationAttention({ db: mockDb, delivery }),
    ).rejects.toThrow("not ready");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  },
);

it("checks lease expiration after obtaining the access lock", async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        generation,
        granted_generation: generation,
        grant_request_id: account_id,
      },
    ],
  });
  await expect(
    lockCollaborationNotificationAttention({ db: mockDb, delivery }),
  ).rejects.toThrow("lease expired");
  expect(mockQuery).toHaveBeenCalledTimes(2);
  expect(mockQuery.mock.calls[0][0]).toContain("FOR UPDATE");
  expect(mockQuery.mock.calls[1][0]).toContain("lease_until>clock_timestamp()");
});

it("does not apply a stale denied response after a newer grant request", async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        generation,
        granted_generation: generation,
        grant_request_id: project_id,
      },
    ],
  });
  await expect(
    collaborationNotificationStore(jest.fn(), "home-bay").acknowledge(job, {
      allowed: false,
    }),
  ).rejects.toThrow("superseded");
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

it("unknown access is retryable, not a success that consumes the message", async () => {
  await expect(
    lockCollaborationNotificationAttention({ db: mockDb, delivery }),
  ).rejects.toThrow("not ready");
});

it.each([true, false])(
  "attention uses complete indexed participation (%s), never the preview",
  async (participated) => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            generation,
            granted_generation: generation,
            grant_request_id: account_id,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({
        rows: [
          {
            metadata: resource,
            participant_ids: participated ? [] : [account_id],
            participated,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            legacy_migrated: true,
            following: false,
            muted: false,
            read_through: 0,
            notify_after: 0,
            last_mention: 0,
          },
        ],
      });
    const result = await lockCollaborationNotificationAttention({
      db: mockDb,
      delivery,
    });
    expect(result?.state.participating).toBe(participated);
    const sql = mockQuery.mock.calls.find(([sql]) =>
      sql.includes("FROM collaboration_index i"),
    )?.[0];
    expect(sql).toContain("collaboration_participant_index");
    expect(sql).toContain("relations_complete");
  },
);

it("does not open or commit a second transaction inside source ingest", async () => {
  await appendCollaborationNotificationEvents(
    mockDb,
    {
      project_id,
      chat_path: "/home/user/room.chat",
      epoch: generation,
      sequence: 1,
      resources: [],
      notification_events: [],
    },
    { owning_bay_id: "owner", host_id: account_id },
  );
  expect(mockQuery).not.toHaveBeenCalled();
  await expect(
    appendCollaborationNotificationEvents(
      mockDb,
      {
        project_id,
        chat_path: "/home/user/room.chat",
        epoch: generation,
        sequence: 1,
        resources: [],
        notification_events: [delivery.event],
      },
      { owning_bay_id: "owner", host_id: account_id },
    ),
  ).rejects.toThrow("writer unavailable");
  expect(
    mockQuery.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)),
  ).toBe(false);
});
