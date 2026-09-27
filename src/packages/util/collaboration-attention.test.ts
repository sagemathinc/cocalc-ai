import {
  COLLABORATION_MENTION_LIMIT,
  collaborationForYouReason,
  collaborationNotificationKey,
  collaborationNotificationReason,
  collaborationReadThrough,
  reconcileCollaborationAttention,
  validateCollaborationMessageEvent,
} from "./collaboration-attention";
import type { CollaborationMessageEvent } from "./collaboration-attention";

const alice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const event: CollaborationMessageEvent = {
  version: 1,
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  thread_id: "thread-1",
  message_id: "message-1",
  actor_account_id: alice,
  activity: 11,
  mode: "live",
  mentioned_account_ids: [],
  mention_all: false,
};
const initial = () =>
  reconcileCollaborationAttention({ account_id: bob, initial_activity: 10 });

it("marks existing history read at a visible persisted starting boundary", () => {
  const state = initial();
  expect(state).toMatchObject({
    read_through: 10,
    notify_after: 10,
    following: false,
  });
  expect(
    collaborationNotificationReason({ event, state, account_id: bob }),
  ).toBeUndefined();
  expect(
    collaborationNotificationReason({
      event: { ...event, activity: 10, mention_all: true },
      state: { ...state, following: true },
      account_id: bob,
    }),
  ).toBeUndefined();
});

it("preserves legacy follower and mute choices without deriving follows from participation", () => {
  const state = reconcileCollaborationAttention({
    account_id: bob,
    initial_activity: 10,
    state: { participating: true },
    legacy: { notification_followers: [bob], notification_muted: [bob] },
  });
  expect(state).toMatchObject({
    following: true,
    muted: true,
    legacy_migrated: true,
  });
  expect(
    collaborationNotificationReason({ event, state, account_id: bob }),
  ).toBeUndefined();
  const participant = { ...initial(), participating: true };
  expect(collaborationForYouReason(participant)).toBe("participation");
  expect(
    collaborationNotificationReason({
      event,
      state: participant,
      account_id: bob,
    }),
  ).toBeUndefined();
});

it("explicit personal false overrides legacy true and migration ignores subsequent legacy writers", () => {
  const state = reconcileCollaborationAttention({
    account_id: bob,
    initial_activity: 10,
    state: { following: false, muted: false },
    legacy: { notification_followers: [bob], notification_muted: [bob] },
  });
  expect(state).toMatchObject({ following: false, muted: false });
  expect(
    reconcileCollaborationAttention({
      account_id: bob,
      initial_activity: 999,
      state,
      legacy: { notification_followers: [bob], notification_muted: [bob] },
    }),
  ).toEqual(state);
});

it.each([false, true])(
  "explicit mentions override mute=%s and take precedence over follows",
  (muted) => {
    const state = { ...initial(), following: true, muted };
    expect(
      collaborationNotificationReason({
        event: { ...event, mentioned_account_ids: [bob] },
        state,
        account_id: bob,
      }),
    ).toBe("mention");
    expect(
      collaborationNotificationReason({
        event: { ...event, mention_all: true },
        state,
        account_id: bob,
      }),
    ).toBe("mention");
  },
);

it("neither mentioning nor sending changes follow or mute choices", () => {
  const state = { ...initial(), muted: true };
  const copy = { ...state };
  expect(
    collaborationNotificationReason({
      event: { ...event, mentioned_account_ids: [bob] },
      state,
      account_id: bob,
    }),
  ).toBe("mention");
  expect(
    collaborationNotificationReason({
      event: { ...event, actor_account_id: bob, mention_all: true },
      state,
      account_id: bob,
    }),
  ).toBeUndefined();
  expect(state).toEqual(copy);
});

it("follows notify without participation, while mute suppresses only follower delivery", () => {
  const state = { ...initial(), following: true };
  expect(
    collaborationNotificationReason({ event, state, account_id: bob }),
  ).toBe("thread_follow");
  expect(
    collaborationNotificationReason({
      event,
      state: { ...state, muted: true },
      account_id: bob,
    }),
  ).toBeUndefined();
});

it("never delivers history/backfills even to mentioned followers", () => {
  expect(
    collaborationNotificationReason({
      event: { ...event, mode: "backfill", mention_all: true },
      state: { ...initial(), following: true },
      account_id: bob,
    }),
  ).toBeUndefined();
});

it("read boundaries suppress mentions and cannot be moved backwards or beyond known activity", () => {
  let previous = 10;
  for (const requested of [15, 12, 9, 13]) {
    previous = collaborationReadThrough({ previous, requested, activity: 20 });
  }
  expect(previous).toBe(15);
  expect(
    collaborationReadThrough({ previous, requested: 99999, activity: 20 }),
  ).toBe(20);
  expect(
    collaborationReadThrough({ previous, requested: 1, activity: 1 }),
  ).toBe(15);
  expect(
    collaborationNotificationReason({
      event: { ...event, mentioned_account_ids: [bob] },
      state: { ...initial(), read_through: previous },
      account_id: bob,
    }),
  ).toBeUndefined();
});

it("out-of-order live messages are not suppressed by a last-delivered high-water mark", () => {
  const state = { ...initial(), following: true };
  for (const activity of [15, 11, 14, 12]) {
    expect(
      collaborationNotificationReason({
        event: { ...event, activity },
        state,
        account_id: bob,
      }),
    ).toBe("thread_follow");
  }
  expect(state.notify_after).toBe(10);
  expect(state.read_through).toBe(10);
});

it("provides explainable For you reasons independently of push mute", () => {
  expect(collaborationForYouReason(initial())).toBeUndefined();
  expect(collaborationForYouReason({ ...initial(), participating: true })).toBe(
    "participation",
  );
  expect(
    collaborationForYouReason({
      ...initial(),
      participating: true,
      following: true,
      muted: true,
    }),
  ).toBe("following");
  expect(
    collaborationForYouReason({
      ...initial(),
      following: true,
      muted: true,
      last_mention: 11,
    }),
  ).toBe("mention");
  expect(
    collaborationForYouReason({ ...initial(), last_mention: 10 }),
  ).toBeUndefined();
});

it("requires reconciliation before notification delivery", () => {
  expect(() =>
    collaborationNotificationReason({
      event,
      state: { ...initial(), legacy_migrated: false },
      account_id: bob,
    }),
  ).toThrow("reconciled");
});

it("normalizes and bounds account expansion without accepting malformed IDs", () => {
  expect(
    validateCollaborationMessageEvent({
      ...event,
      mentioned_account_ids: [bob.toUpperCase(), bob],
    }).mentioned_account_ids,
  ).toEqual([bob]);
  expect(() =>
    validateCollaborationMessageEvent({
      ...event,
      mentioned_account_ids: ["not-an-account"],
    }),
  ).toThrow();
  expect(() =>
    validateCollaborationMessageEvent({
      ...event,
      mentioned_account_ids: Array(COLLABORATION_MENTION_LIMIT + 1).fill(bob),
    }),
  ).toThrow("capacity");
  expect(() =>
    reconcileCollaborationAttention({
      account_id: bob,
      initial_activity: 0,
      legacy: {
        notification_followers: Array(COLLABORATION_MENTION_LIMIT + 1).fill(
          bob,
        ),
      },
    }),
  ).toThrow("capacity");
});

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid persisted activity %s",
  (activity) => {
    expect(() =>
      validateCollaborationMessageEvent({ ...event, activity }),
    ).toThrow();
    expect(() =>
      collaborationReadThrough({
        previous: 0,
        requested: activity,
        activity: 10,
      }),
    ).toThrow();
  },
);

it("strips unknown transcript fields and requires explicit event mode", () => {
  expect(
    validateCollaborationMessageEvent({
      ...event,
      body: "private text",
    } as CollaborationMessageEvent),
  ).toEqual(event);
  expect(() =>
    validateCollaborationMessageEvent({ ...event, mode: undefined } as any),
  ).toThrow();
  expect(() =>
    validateCollaborationMessageEvent({ ...event, activity: 0 }),
  ).toThrow();
});

it("dedup identity includes message, recipient and reason, never locator or activity", () => {
  const key = collaborationNotificationKey(event, bob, "mention");
  expect(
    collaborationNotificationKey(
      { ...event, activity: 50 },
      bob.toUpperCase(),
      "mention",
    ),
  ).toBe(key);
  expect(collaborationNotificationKey(event, alice, "mention")).not.toBe(key);
  expect(collaborationNotificationKey(event, bob, "thread_follow")).not.toBe(
    key,
  );
  expect(
    collaborationNotificationKey(
      { ...event, message_id: "message-2" },
      bob,
      "mention",
    ),
  ).not.toBe(key);
  expect(
    collaborationNotificationKey(
      { ...event, room_id: event.project_id },
      bob,
      "mention",
    ),
  ).not.toBe(key);
  expect(
    collaborationNotificationKey(
      { ...event, thread_id: "a:b", message_id: "c" },
      bob,
      "mention",
    ),
  ).not.toBe(
    collaborationNotificationKey(
      { ...event, thread_id: "a", message_id: "b:c" },
      bob,
      "mention",
    ),
  );
});
