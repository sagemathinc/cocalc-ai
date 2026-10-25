/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush sync notices and retention emails against a real database
// (pglite), with Sagebrush faked. See docs/sagebrush.md, section 4.

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
const mockAlert = jest.fn();
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAlert(...args),
}));

import {
  BEFORE_DELETION_MS,
  checkSyncStates,
  deliverDueSyncNotices,
  RECHECK_MS,
  runDueRetentionSteps,
} from "./sync-retention";

const config = { origin: "https://sagebrush.test", secret: "limits-key" };
const DAY = 24 * 60 * 60_000;

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

function limits(enabled: boolean) {
  return {
    tier: enabled ? "pro" : "free",
    storage_bytes: 1000,
    max_file_bytes: 100,
    private_links: false,
    sync: {
      enabled,
      version_bytes: 10,
      read_bytes_per_day: 10,
      retention_days: 90,
    },
  };
}

// A fake Sagebrush: its notices received, and the retention it answers.
function fakeSagebrush() {
  const s = {
    notices: [] as any[],
    retention: new Map<string, any>(),
    noticeStatus: 200,
  };
  const fetch = async (url: any, init: any) => {
    const path = new URL(`${url}`).pathname;
    if (path === "/api/admin/limits") {
      s.notices.push(JSON.parse(init.body));
      return s.noticeStatus === 200
        ? new Response(JSON.stringify({ applied: true }), { status: 200 })
        : new Response("down", { status: s.noticeStatus });
    }
    const m = path.match(/^\/api\/admin\/sync-retention\/(.+)$/);
    if (m) {
      const r = s.retention.get(m[1]);
      return r
        ? new Response(
            JSON.stringify({ account_id: m[1], ...r, now: Date.now() }),
            { status: 200 },
          )
        : new Response("this account never synced", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { s, fetch: fetch as any };
}

async function insertAccount(): Promise<string> {
  const account_id = randomUUID();
  const email_address = `${account_id.slice(0, 8)}@example.com`;
  await getPool().query(
    `INSERT INTO accounts(account_id, email_address, email_address_verified, first_name, last_name, home_bay_id, created)
     VALUES($1, $2, $3, 'Ada', 'Lovelace', 'bay-0', NOW())`,
    [account_id, email_address, { [email_address]: new Date().toISOString() }],
  );
  await getPool().query(
    `INSERT INTO oauth_client_approvals(account_id, client_id, first_approved, last_approved)
     VALUES($1, 'sagebrush', NOW(), NOW())`,
    [account_id],
  );
  return account_id;
}

async function stateOf(account_id: string) {
  return (
    await getPool().query(
      "SELECT * FROM sagebrush_sync_states WHERE account_id = $1",
      [account_id],
    )
  ).rows[0];
}

describeDb("Sagebrush sync notices and retention emails", () => {
  const enabled = new Map<string, boolean>();
  const getLimits = async (account_id: string) =>
    limits(enabled.get(account_id) ?? false);
  let clock = Date.now();
  const now = () => clock;
  const sent: any[] = [];
  const send = async (message: any) => {
    sent.push(message);
  };

  beforeAll(async () => {
    await syncSchema({
      accounts: SCHEMA.accounts,
      oauth_client_approvals: SCHEMA.oauth_client_approvals,
      sagebrush_sync_states: SCHEMA.sagebrush_sync_states,
    });
  });

  beforeEach(async () => {
    mockSettings = { site_name: "CoCalc" };
    mockAlert.mockReset();
    enabled.clear();
    sent.length = 0;
    clock = Date.now();
    await getPool().query("DELETE FROM sagebrush_sync_states");
    await getPool().query("DELETE FROM oauth_client_approvals");
  });

  // One maintenance pass, at the fake clock.
  async function pass(fetch: any) {
    await checkSyncStates({ getLimits, now });
    await deliverDueSyncNotices({ config, fetch, now });
    await runDueRetentionSteps({ config, fetch, now, send });
  }

  it("emails twice when sync ends, the second about 14 days before deletion", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    // The first check only records the state.
    expect((await stateOf(account_id)).sync_enabled).toBe(true);
    expect(s.notices).toHaveLength(0);

    // The membership ends; the next check (after RECHECK_MS) sees it.
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    const purge_after = clock + 90 * DAY;
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock,
      purge_after,
    });
    await pass(fetch);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ account_id, issued: clock });
    expect(s.notices[0].limits.sync.enabled).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toMatch(/@example\.com$/);
    expect(sent[0].subject).toMatch(/sync has ended/);
    let row = await stateOf(account_id);
    expect(row.email_stage).toBe("before");
    expect(new Date(row.email_next_at).valueOf()).toBe(
      purge_after - BEFORE_DELETION_MS,
    );

    // Nothing more until then.
    clock = purge_after - BEFORE_DELETION_MS - DAY;
    await pass(fetch);
    expect(sent).toHaveLength(1);

    clock = purge_after - BEFORE_DELETION_MS + 1;
    await pass(fetch);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toMatch(/will be deleted on/);
    row = await stateOf(account_id);
    expect(row.email_stage).toBe("done");
    expect(row.before_email_sent_at).not.toBeNull();
  });

  it("sends no email for an account that never synced", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    await pass(fetch);
    expect(s.notices).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect((await stateOf(account_id)).email_stage).toBe("cancelled");
  });

  it("cancels the second email when sync comes back, and tells Sagebrush", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock,
      purge_after: clock + 90 * DAY,
    });
    await pass(fetch);
    expect(sent).toHaveLength(1);

    enabled.set(account_id, true);
    clock += RECHECK_MS + 1;
    s.retention.set(account_id, {
      state: "active",
      readonly_since: null,
      purge_after: null,
    });
    await pass(fetch);
    expect(s.notices).toHaveLength(2);
    expect(s.notices[1].limits.sync.enabled).toBe(true);
    expect((await stateOf(account_id)).email_stage).toBe("cancelled");
    clock += 100 * DAY;
    await pass(fetch);
    expect(sent).toHaveLength(1);
  });

  it("re-reads before the second email and sends nothing once renewed on Sagebrush's side", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    const purge_after = clock + 90 * DAY;
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock,
      purge_after,
    });
    await pass(fetch);
    // Sagebrush says it is no longer read-only (for example its own fetch saw a renewal first).
    s.retention.set(account_id, {
      state: "active",
      readonly_since: null,
      purge_after: null,
    });
    clock = purge_after - BEFORE_DELETION_MS + 1;
    await pass(fetch);
    expect(sent).toHaveLength(1);
    expect((await stateOf(account_id)).email_stage).toBe("cancelled");
  });

  it("retries a notice Sagebrush doesn't accept, and the emails wait for it", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock,
      purge_after: clock + 90 * DAY,
    });
    s.noticeStatus = 503;
    await pass(fetch);
    let row = await stateOf(account_id);
    expect(row.notice_attempts).toBe(1);
    expect(row.notice_accepted_at).toBeNull();
    expect(row.last_error).toMatch(/HTTP 503/);
    expect(sent).toHaveLength(0);
    // The same request id, once due again.
    s.noticeStatus = 200;
    clock += 2 * 60_000;
    await pass(fetch);
    expect(s.notices).toHaveLength(2);
    expect(s.notices[1].request_id).toBe(s.notices[0].request_id);
    row = await stateOf(account_id);
    expect(row.notice_accepted_at).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("alerts the admins at once when Sagebrush rejects the signature", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    s.noticeStatus = 401;
    await pass(fetch);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0].body).toMatch(/Limits Key/);
  });

  it("acts only for accounts whose home bay this is", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    await getPool().query(
      "UPDATE accounts SET home_bay_id = 'bay-9' WHERE account_id = $1",
      [account_id],
    );
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    await pass(fetch);
    expect(s.notices).toHaveLength(0);
    expect((await stateOf(account_id)).sync_enabled).toBeNull();
  });
});
