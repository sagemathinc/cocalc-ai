import type { PoolClient } from "@cocalc/database/pool";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import type { CreateNotificationEventInput } from "@cocalc/database/postgres/notifications-core";
import { queueContentInvitationNotification } from "./content-invitation";
import type { ContentInvitationNotificationInput } from "./content-invitation";

jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "sender-home",
}));

const graph = createNotificationEventGraphInTransaction as jest.Mock;
let input: ContentInvitationNotificationInput;
let events: Map<string, CreateNotificationEventInput>;

beforeEach(() => {
  jest.clearAllMocks();
  events = new Map();
  const db = {
    query: jest.fn(async (sql: string, [id]: string[]) => {
      const event = sql.includes("SELECT e.payload_json")
        ? events.get(id)
        : undefined;
      return {
        rows: event
          ? event.targets.map((target) => ({
              notification_id: target.notification_id,
              target_account_id: target.target_account_id,
              payload_json: event.payload_json,
            }))
          : [],
      };
    }),
  } as unknown as PoolClient;
  input = {
    db,
    operation_id: "11111111-1111-4111-8111-111111111111",
    invitation_id: "22222222-2222-4222-8222-222222222222",
    sender_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recipient_account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    recipient_home_bay_id: "recipient-home",
    project_id: "33333333-3333-4333-8333-333333333333",
    authored_label: "Prime numbers",
    message: "Please look at this.",
    channels: { notification: true, email: false },
  };
  graph.mockImplementation(async ({ input: event }) => {
    events.set(event.event_id, event);
    return {};
  });
});

it("queues existing-access content with no access invite, lookup, or runtime target", async () => {
  const result = await queueContentInvitationNotification(input);
  expect(result.status).toBe("queued");
  expect(graph).toHaveBeenCalledWith({
    db: input.db,
    input: expect.objectContaining({
      kind: "account_notice",
      source_bay_id: "sender-home",
      origin_kind: "account",
      actor_account_id: input.sender_account_id,
      targets: [
        expect.objectContaining({
          target_account_id: input.recipient_account_id,
          target_home_bay_id: "recipient-home",
          summary_json: expect.objectContaining({
            notice_type: "collaboration_invitation",
            access_invite_ids: [],
            invitation_channels: { notification: true, email: false },
            action_link: `/people/invites/?invitation_id=${input.invitation_id}`,
          }),
        }),
      ],
    }),
  });
  const event = graph.mock.calls[0][0].input;
  expect(event.source_path).toBeUndefined();
  expect(event.payload_json.body_markdown).toBeUndefined();
  expect(event.payload_json.body_text).toContain(input.message);
});

it("consolidates access IDs into the same content notice", async () => {
  input.access_invite_ids = [input.operation_id, input.operation_id];
  await queueContentInvitationNotification(input);
  expect(graph).toHaveBeenCalledTimes(1);
  expect(graph.mock.calls[0][0].input.payload_json).toMatchObject({
    access_invite_ids: [input.operation_id],
    body_text: expect.stringContaining("Review and accept them separately"),
  });
});

it("deduplicates unknown-outcome retries without rewriting the notification", async () => {
  const first = await queueContentInvitationNotification(input);
  const retry = await queueContentInvitationNotification({
    ...input,
    recipient_home_bay_id: "moved-recipient-home",
  });
  expect(retry).toEqual({ ...first, status: "duplicate" });
  expect(graph).toHaveBeenCalledTimes(1);
});

it.each([
  { message: "changed" },
  { project_id: "44444444-4444-4444-8444-444444444444" },
  { channels: { notification: true, email: true } },
])("rejects a retry with changed intent: %j", async (change) => {
  await queueContentInvitationNotification(input);
  await expect(
    queueContentInvitationNotification({ ...input, ...change }),
  ).rejects.toThrow("conflicting");
  expect(graph).toHaveBeenCalledTimes(1);
});

it("uses a new notification identity for a separately authorized resend operation", async () => {
  const first = await queueContentInvitationNotification(input);
  const second = await queueContentInvitationNotification({
    ...input,
    operation_id: "44444444-4444-4444-8444-444444444444",
  });
  expect(second).not.toEqual(first);
  expect(graph).toHaveBeenCalledTimes(2);
});

it.each([
  { channels: { notification: false, email: false } },
  { recipient_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
])("suppresses absent delivery or self-notification: %j", async (change) => {
  expect(
    await queueContentInvitationNotification({ ...input, ...change }),
  ).toEqual({ status: "suppressed" });
  expect(graph).not.toHaveBeenCalled();
});

it.each([
  { recipient_account_id: "email@example.com" },
  { recipient_home_bay_id: "" },
  { authored_label: "x".repeat(161) },
  { message: "x".repeat(2001) },
  { message: "bad\0message" },
  { access_invite_ids: Array(26).fill("11111111-1111-4111-8111-111111111111") },
])("rejects invalid or unbounded input: %j", async (change) => {
  await expect(
    queueContentInvitationNotification({ ...input, ...change }),
  ).rejects.toThrow("invalid content invitation");
  expect(graph).not.toHaveBeenCalled();
});

it("does not claim success if notification graph insertion fails", async () => {
  graph.mockRejectedValueOnce(Error("database unavailable"));
  await expect(queueContentInvitationNotification(input)).rejects.toThrow(
    "unavailable",
  );
});
