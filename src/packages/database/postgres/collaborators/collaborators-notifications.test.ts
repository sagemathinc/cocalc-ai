import type { PoolClient } from "../../pool";
import type { CollaborationNotificationDelivery } from "@cocalc/util/collaboration-attention";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { SCHEMA } from "@cocalc/util/schema";
import { syncSchema } from "../schema";
import {
  assertProjectNotRehoming,
  ProjectRehomeInProgressError,
} from "../project-rehome-fence";
import {
  appendCollaborationNotificationEvents,
  ensureCollaborationNotificationSchema,
  initializeCollaborationProjectionAttention,
  lockEventCollaborationNotificationAttention,
  readCollaborationNotificationAttention,
  pruneCollaborationNotificationEvents,
} from "./collaborators-notifications";

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockDb = {
  query: mockQuery,
  release: mockRelease,
} as unknown as PoolClient;
jest.mock("../../pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery, connect: async () => mockDb }),
}));
jest.mock("../account-rehome-fence", () => ({
  withAccountRehomeWriteFence: async ({ fn }) => fn(mockDb),
}));
jest.mock("./collaborators-account-maintenance", () => ({
  lockCollaborationMaintenanceAccounts: async (_db, ids) => new Set(ids),
}));
jest.mock("../project-rehome-fence", () => ({
  assertProjectNotRehoming: jest.fn(),
  ProjectRehomeInProgressError: class extends Error {},
}));
jest.mock("../schema", () => ({ syncSchema: jest.fn() }));

const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const generation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
    collaboration_notification_recipients:
      SCHEMA.collaboration_notification_recipients,
    collaboration_notification_floors: SCHEMA.collaboration_notification_floors,
    collaboration_personal: SCHEMA.collaboration_personal,
    collaboration_notification_delivery_budget:
      SCHEMA.collaboration_notification_delivery_budget,
    collaboration_notification_summary:
      SCHEMA.collaboration_notification_summary,
    collaboration_notification_summary_receipts:
      SCHEMA.collaboration_notification_summary_receipts,
    collaboration_notification_subscriptions:
      SCHEMA.collaboration_notification_subscriptions,
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

it.each(["expired", "generation", "request"])(
  "event authorization rejects %s before personal writes",
  async (failure) => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          generation: failure === "generation" ? generation : null,
          granted_generation: null,
          grant_request_id: failure === "request" ? project_id : account_id,
        },
      ],
    });
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(
      lockEventCollaborationNotificationAttention({
        db: mockDb,
        delivery: {
          ...delivery,
          attention: {
            generation,
            initial_activity: 0,
            participating: false,
            legacy_following: false,
            legacy_muted: false,
          },
        },
        authorization: {
          request_id: account_id,
          generation: null,
          granted_generation: null,
          expires_at: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(failure === "expired" ? "expired" : "superseded");
    expect(mockQuery.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO collaboration_personal"),
      ),
    ).toBe(false);
  },
);

it("owner attention avoids the resource index while preserving explicit mute and membership floor", async () => {
  mockQuery.mockImplementation(async (sql) => {
    if (sql.includes("FROM collaboration_access"))
      return {
        rows: [
          {
            generation,
            granted_generation: generation,
            grant_request_id: account_id,
          },
        ],
      };
    if (
      sql.includes("clock_timestamp()<") ||
      sql.includes("FROM account_project_index")
    )
      return { rows: [{}] };
    if (sql.includes("SELECT * FROM collaboration_personal"))
      return {
        rows: [
          {
            read_through: 1,
            notify_after: 0,
            last_mention: 0,
            muted: true,
            muted_explicit: true,
            following: false,
            legacy_migrated: false,
          },
        ],
      };
    return { rows: [] };
  });
  const result = await lockEventCollaborationNotificationAttention({
    db: mockDb,
    authorization: {
      request_id: account_id,
      generation,
      granted_generation: generation,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    delivery: {
      ...delivery,
      attention: {
        generation,
        initial_activity: 1,
        participating: true,
        legacy_following: true,
        legacy_muted: false,
      },
    },
  });
  expect(result?.state).toMatchObject({
    muted: true,
    following: true,
    participating: true,
    read_through: 1,
    notify_after: 1,
    last_mention: 2,
  });
  expect(
    mockQuery.mock.calls.some(([sql]) =>
      sql.includes("FROM collaboration_index"),
    ),
  ).toBe(false);
});

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
