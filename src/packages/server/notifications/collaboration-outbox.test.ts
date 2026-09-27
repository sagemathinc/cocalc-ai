import { runCollaborationNotificationOutboxPass } from "./collaboration-outbox";
import type {
  CollaborationNotificationOutboxStore,
  CollaborationNotificationPage,
} from "./collaboration-outbox";
import { receiveCollaborationMessageNotification } from "./collaboration";

jest.mock("./collaboration", () => ({
  receiveCollaborationMessageNotification: jest.fn(),
}));
const receive = receiveCollaborationMessageNotification as jest.Mock;
const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const job = {
  account_id,
  project_id,
  claim_id: "claim",
  grant_request_id: account_id,
  generation: "generation",
  cursor: "1",
};
let page: Extract<CollaborationNotificationPage, { allowed: true }>;
let store: CollaborationNotificationOutboxStore;

beforeEach(() => {
  jest.resetAllMocks();
  const event = {
    version: 1 as const,
    project_id,
    room_id: project_id,
    thread_id: "thread",
    message_id: "message",
    actor_account_id: project_id,
    activity: 1,
    mode: "live" as const,
    mentioned_account_ids: [account_id],
    mention_all: false,
  };
  page = {
    allowed: true,
    generation: job.generation,
    access_generation: job.generation,
    cursor: "2",
    complete: true,
    reset: false,
    entries: [
      {
        event,
        authority: {
          project_id,
          room_id: event.room_id,
          thread_id: event.thread_id,
          owning_bay_id: "owner",
          chat_path: "/home/user/room.chat",
          access_generation: job.generation,
          actor_role: "owner",
          recipient_role: "collaborator",
        },
      },
    ],
  };
  store = {
    claim: jest.fn(async () => [job]),
    readPage: jest.fn(async () => page),
    acknowledge: jest.fn(async () => true),
    fail: jest.fn(async () => {}),
  };
  receive.mockResolvedValue({
    status: "created",
    notification_id: "notification",
  });
});

const run = (options: { now?: () => number } = {}) =>
  runCollaborationNotificationOutboxPass({
    store,
    lockAttention: jest.fn(),
    ...options,
  });

it("claims bounded pages and acknowledges only after every delivery completes", async () => {
  const result = await run();
  expect(store.claim).toHaveBeenCalledWith(8);
  expect(store.readPage).toHaveBeenCalledWith(job, 25);
  expect(store.acknowledge).toHaveBeenCalledWith(job, page);
  expect(result).toMatchObject({
    claimed: 1,
    created: 1,
    acknowledged: 1,
    failed: 0,
  });
  expect(receive.mock.invocationCallOrder[0]).toBeLessThan(
    (store.acknowledge as jest.Mock).mock.invocationCallOrder[0],
  );
});

it("does not acknowledge partial failures, so the same page is durably retried", async () => {
  page.entries.push({
    ...page.entries[0],
    event: { ...page.entries[0].event, message_id: "second" },
  });
  receive
    .mockResolvedValueOnce({ status: "created" })
    .mockRejectedValueOnce(Error("outbox unavailable"));
  expect(await run()).toMatchObject({ created: 1, failed: 1, acknowledged: 0 });
  expect(store.acknowledge).not.toHaveBeenCalled();
  expect(store.fail).toHaveBeenCalledWith(job, expect.any(Error));
});

it("preserves pending delivery when only project authority generation changes", async () => {
  page.access_generation = "new-project-authority";
  page.entries[0].authority.access_generation = page.access_generation;
  expect(await run()).toMatchObject({ created: 1, acknowledged: 1, failed: 0 });
  expect(receive).toHaveBeenCalledWith(
    expect.objectContaining({ access_generation: page.access_generation }),
    expect.anything(),
  );
});

it("a lost cursor acknowledgment retries notifications instead of consuming the page", async () => {
  (store.acknowledge as jest.Mock).mockRejectedValueOnce(
    Error("commit outcome unknown"),
  );
  expect(await run()).toMatchObject({ created: 1, failed: 1 });
  receive.mockResolvedValue({ status: "duplicate" });
  expect(await run()).toMatchObject({ duplicate: 1, acknowledged: 1 });
});

it.each(["initial", "rejoin"])(
  "establishes an explicit %s boundary without processing history",
  async () => {
    page.reset = true;
    page.entries = [];
    page.cursor = "1000";
    expect(await run()).toMatchObject({ created: 0, acknowledged: 1 });
    expect(receive).not.toHaveBeenCalled();
  },
);

it("rejects history hidden in a reset and does not advance its cursor", async () => {
  page.reset = true;
  expect(await run()).toMatchObject({ failed: 1, acknowledged: 0 });
  expect(receive).not.toHaveBeenCalled();
});

it("invalidates definitively revoked access rather than delivering metadata", async () => {
  (store.readPage as jest.Mock).mockResolvedValue({ allowed: false });
  expect(await run()).toMatchObject({ created: 0, acknowledged: 1 });
  expect(store.acknowledge).toHaveBeenCalledWith(job, { allowed: false });
  expect(receive).not.toHaveBeenCalled();
});

it("rejects cursor stalls, mismatched generations and duplicate event IDs", async () => {
  page.cursor = job.cursor;
  expect(await run()).toMatchObject({ failed: 1 });
  page.cursor = "2";
  page.generation = "another-generation";
  expect(await run()).toMatchObject({ failed: 1 });
  page.generation = job.generation;
  page.entries.push(page.entries[0]);
  expect(await run()).toMatchObject({ failed: 1 });
  expect(receive).not.toHaveBeenCalled();
});

it("rejects expired owner authority before delivery without using clocks as read positions", async () => {
  let calls = 0;
  expect(await run({ now: () => (calls++ ? 60_000 : 0) })).toMatchObject({
    failed: 1,
  });
  expect(receive).not.toHaveBeenCalled();
});

it("rejects oversized pages and oversized job claims", async () => {
  page.entries = Array(26).fill(page.entries[0]);
  expect(await run()).toMatchObject({ failed: 1 });
  (store.claim as jest.Mock).mockResolvedValue(Array(9).fill(job));
  await expect(run()).rejects.toThrow("capacity");
  expect(receive).not.toHaveBeenCalled();
});

it("retains retry work when a later claim superseded this worker", async () => {
  (store.acknowledge as jest.Mock).mockResolvedValue(false);
  expect(await run()).toMatchObject({ failed: 1, acknowledged: 0 });
  expect(store.fail).toHaveBeenCalledWith(job, expect.any(Error));
});
