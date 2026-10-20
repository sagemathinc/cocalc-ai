/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  awayDecision,
  codexNotificationEmailEnabled,
  emailWaitsUntilAway,
  revalidateNotificationEmail,
} from "./notification-email-outbox";

describe("Codex notification email rollout gate", () => {
  const original = process.env.COCALC_CODEX_ATTENTION_EMAIL;

  afterEach(() => {
    if (original == null) {
      delete process.env.COCALC_CODEX_ATTENTION_EMAIL;
    } else {
      process.env.COCALC_CODEX_ATTENTION_EMAIL = original;
    }
  });

  it("is default-off and can be enabled independently", () => {
    delete process.env.COCALC_CODEX_ATTENTION_EMAIL;
    expect(codexNotificationEmailEnabled()).toBe(false);
    process.env.COCALC_CODEX_ATTENTION_EMAIL = "1";
    expect(codexNotificationEmailEnabled()).toBe(true);
  });
});

describe("notification email only when you are away", () => {
  const MIN = 60_000;
  const now = new Date("2026-10-20T08:00:00Z");
  const ago = (minutes: number) => new Date(now.valueOf() - minutes * MIN);

  it("waits for ordinary notifications, never for critical mail or invites", () => {
    const row = (lane: string, category: string, delivery_mode = "immediate") =>
      ({ lane, category, delivery_mode }) as any;
    expect(emailWaitsUntilAway(row("notification", "mentions"))).toBe(true);
    expect(emailWaitsUntilAway(row("notification", "ai"))).toBe(true);
    expect(emailWaitsUntilAway(row("transactional", "support"))).toBe(true);
    for (const r of [
      row("critical", "security"),
      row("critical", "billing"),
      row("critical", "maintenance"),
      row("transactional", "membership_requests"),
      row("transactional", "access_requests"),
      row("notification", "mentions", "digest"),
    ])
      expect(emailWaitsUntilAway(r)).toBe(false);
  });

  it("emails only once unresolved for 15 minutes and you have been away as long", () => {
    // Too new: wait until it is 15 minutes old.
    expect(awayDecision({ created_at: ago(5), now })).toEqual({
      action: "reschedule",
      scheduled_at: new Date(ago(5).valueOf() + 15 * MIN),
      reason: "emailed only if still unresolved after a while",
    });
    // Old enough, but you were here 3 minutes ago: wait until you leave.
    expect(
      awayDecision({ created_at: ago(30), last_active: ago(3), now }),
    ).toEqual({
      action: "reschedule",
      scheduled_at: new Date(ago(3).valueOf() + 15 * MIN),
      reason: "the person is using CoCalc",
    });
    // Away long enough: send.
    expect(
      awayDecision({ created_at: ago(30), last_active: ago(20), now }),
    ).toBeUndefined();
    expect(awayDecision({ created_at: ago(30), now })).toBeUndefined();
    // Read meanwhile: never.
    expect(
      awayDecision({
        created_at: ago(30),
        last_active: ago(20),
        read: true,
        now,
      }),
    ).toMatchObject({ action: "skip" });
  });

  it("is checked before every send, from the account and the notification", async () => {
    const queries: any[] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ last_active: ago(2), read_state: { read: false } }] };
      },
    };
    const row = {
      email_id: "e1",
      notification_id: "11111111-1111-4111-8111-111111111111",
      target_account_id: "22222222-2222-4222-8222-222222222222",
      category: "mentions",
      lane: "notification",
      delivery_mode: "immediate",
      created_at: ago(60),
      summary_json: { kind: "mention" },
    } as any;
    await expect(
      revalidateNotificationEmail({ row, now, db: db as any }),
    ).resolves.toMatchObject({
      action: "reschedule",
      reason: "the person is using CoCalc",
    });
    expect(queries[0].params).toEqual([
      row.target_account_id,
      row.notification_id,
    ]);
    // Homed here: the same answer.
    await expect(
      revalidateNotificationEmail({
        row,
        now,
        db: db as any,
        home: { current: "bay-1", local: "bay-1" },
      }),
    ).resolves.toMatchObject({ action: "reschedule" });
    // The account moved to another bay (or the directory could not say):
    // this bay's activity is stale, so the email goes out as it used to.
    queries.length = 0;
    for (const current of ["bay-2", ""])
      await expect(
        revalidateNotificationEmail({
          row,
          now,
          db: db as any,
          home: { current, local: "bay-1" },
        }),
      ).resolves.toEqual({ action: "send" });
    expect(queries).toHaveLength(0);
  });
});
