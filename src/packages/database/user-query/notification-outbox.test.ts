/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appendMentionNotificationOutboxEvent } from "@cocalc/database/postgres/notification-events-outbox";
import { _user_set_query_mention_change_after } from "./methods-impl";

jest.mock("@cocalc/database/postgres/notification-events-outbox", () => ({
  __esModule: true,
  appendMentionNotificationOutboxEvent: jest.fn(async () => "event-id"),
}));

describe("mention user-query outbox hooks", () => {
  const ctx = {
    _dbg: jest.fn(() => () => {}),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function runHook(old_val: any, new_val: any): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      _user_set_query_mention_change_after.call(
        ctx,
        old_val,
        new_val,
        "11111111-1111-4111-8111-111111111111",
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  it("emits an outbox event for a new mention", async () => {
    await runHook(
      {},
      {
        time: new Date("2026-04-03T23:00:00.000Z"),
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "chat/a.md",
        target: "22222222-2222-4222-8222-222222222222",
        users: {
          "22222222-2222-4222-8222-222222222222": { read: false },
        },
      },
    );
    expect(appendMentionNotificationOutboxEvent).toHaveBeenCalledWith({
      time: new Date("2026-04-03T23:00:00.000Z"),
      project_id: "11111111-1111-4111-8111-111111111111",
      path: "chat/a.md",
      target: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("emits an outbox event when mention read_state changes", async () => {
    await runHook(
      {
        time: new Date("2026-04-03T23:00:00.000Z"),
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "chat/a.md",
        target: "22222222-2222-4222-8222-222222222222",
        users: {
          "22222222-2222-4222-8222-222222222222": { read: false },
        },
      },
      {
        time: new Date("2026-04-03T23:00:00.000Z"),
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "chat/a.md",
        target: "22222222-2222-4222-8222-222222222222",
        users: {
          "22222222-2222-4222-8222-222222222222": { read: true },
        },
      },
    );
    expect(appendMentionNotificationOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it("does not emit an outbox event when mention fields did not change", async () => {
    await runHook(
      {
        time: new Date("2026-04-03T23:00:00.000Z"),
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "chat/a.md",
        target: "22222222-2222-4222-8222-222222222222",
        users: {
          "22222222-2222-4222-8222-222222222222": { read: false },
        },
      },
      {
        time: new Date("2026-04-03T23:00:00.000Z"),
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "chat/a.md",
        target: "22222222-2222-4222-8222-222222222222",
        users: {
          "22222222-2222-4222-8222-222222222222": { read: false },
        },
      },
    );
    expect(appendMentionNotificationOutboxEvent).not.toHaveBeenCalled();
  });
});
