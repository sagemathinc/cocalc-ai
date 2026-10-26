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
import { getOAuthAccountStateLocal } from "@cocalc/server/auth/oauth/account-state";

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
const mockAlert = jest.fn();
// The routed account state (getOAuthAccountState asks the account's home bay):
// by default this bay's own answer, which is what the routing gives for an
// account homed here; the rehome tests answer as the new home bay would.
const mockRouted = jest.fn();
jest.mock("@cocalc/server/auth/oauth/account-state", () => ({
  ...jest.requireActual("@cocalc/server/auth/oauth/account-state"),
  getOAuthAccountState: (...args: any[]) => mockRouted(...args),
}));
// Everything logged by any module (a var: modules log while being imported,
// before this line runs).
// eslint-disable-next-line no-var
var mockLogged: any[] = [];
jest.mock("@cocalc/backend/logger", () => {
  const logger = (): any =>
    new Proxy(
      {},
      {
        get:
          (_target, level) =>
          (...args: any[]) => {
            (mockLogged ??= []).push([String(level), ...args]);
            return logger();
          },
      },
    );
  return {
    ...jest.requireActual("@cocalc/backend/logger"),
    __esModule: true,
    default: logger,
    getLogger: logger,
  };
});
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAlert(...args),
}));

import {
  BEFORE_DELETION_MS,
  checkSyncStates,
  deliverDueSyncNotices,
  escalateUnresolvedRetentionEmails,
  RECHECK_MS,
  resolveRetentionEmail,
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
      sagebrush_sync_emails: SCHEMA.sagebrush_sync_emails,
    });
  });

  beforeEach(async () => {
    mockSettings = { site_name: "CoCalc" };
    mockAlert.mockReset();
    mockAlert.mockResolvedValue(1);
    mockRouted.mockReset();
    mockRouted.mockImplementation((account_id: string) =>
      getOAuthAccountStateLocal({ account_id }),
    );
    mockLogged.length = 0;
    enabled.clear();
    sent.length = 0;
    clock = Date.now();
    await getPool().query("DELETE FROM sagebrush_sync_states");
    await getPool().query("DELETE FROM sagebrush_sync_emails");
    await getPool().query("DELETE FROM oauth_client_approvals");
  });

  // One maintenance pass, at the fake clock.
  async function pass(fetch: any) {
    await checkSyncStates({ getLimits, now });
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    await runDueRetentionSteps({ config, fetch, now, send, getLimits });
  }

  // Steps only, with the usual dependencies unless overridden.
  function steps(fetch: any, opts: Record<string, any> = {}) {
    return runDueRetentionSteps({
      config,
      fetch,
      now,
      send,
      getLimits,
      ...opts,
    });
  }

  // An account that synced, after its first check.
  async function syncedAccount(fetch: any): Promise<string> {
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    return account_id;
  }

  // The membership ends, and Sagebrush will say the data is read-only.
  // Returns the deletion date.
  function lapse(s: any, account_id: string): number {
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    const purge_after = clock + 90 * DAY;
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock,
      purge_after,
    });
    return purge_after;
  }

  // Up to the first email's step: the change seen and its notice accepted.
  async function toFirstEmail(s: any, fetch: any) {
    const account_id = await syncedAccount(fetch);
    const purge_after = lapse(s, account_id);
    await checkSyncStates({ getLimits, now });
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    expect((await stateOf(account_id)).email_stage).toBe("ended");
    return { account_id, purge_after };
  }

  // Several accounts up to their first email's step, together.
  async function toFirstEmails(s: any, fetch: any, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const account_id = await insertAccount();
      enabled.set(account_id, true);
      ids.push(account_id);
    }
    await pass(fetch);
    for (const account_id of ids) lapse(s, account_id);
    await checkSyncStates({ getLimits, now });
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    for (const account_id of ids) {
      expect((await stateOf(account_id)).email_stage).toBe("ended");
    }
    return ids;
  }

  async function deliveries(account_id: string) {
    return (
      await getPool().query(
        "SELECT * FROM sagebrush_sync_emails WHERE account_id = $1 ORDER BY created",
        [account_id],
      )
    ).rows;
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
    expect(row.last_error).toBe("http_error 503");
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

  it("tells Sagebrush on a first check when it still holds the data read-only (after a rehome)", async () => {
    const { s, fetch } = fakeSagebrush();
    // The old home bay ended sync on Sagebrush; the account renewed and is
    // first seen here with sync enabled.
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock - DAY,
      purge_after: clock + 89 * DAY,
    });
    expect(await checkSyncStates({ config, fetch, getLimits, now })).toBe(1);
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ account_id, issued: clock });
    expect(s.notices[0].limits.sync.enabled).toBe(true);
    const row = await stateOf(account_id);
    expect(row.sync_enabled).toBe(true);
    expect(row.notice_accepted_at).not.toBeNull();
    expect(row.email_stage).toBeNull();

    // Checked again later: no further notice.
    clock += RECHECK_MS + 1;
    expect(await checkSyncStates({ config, fetch, getLimits, now })).toBe(0);
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    expect(s.notices).toHaveLength(1);

    // A first check of an account Sagebrush has active (or never saw) only
    // records it, as before.
    const other = await insertAccount();
    enabled.set(other, true);
    s.retention.set(other, {
      state: "active",
      readonly_since: null,
      purge_after: null,
    });
    expect(await checkSyncStates({ config, fetch, getLimits, now })).toBe(0);
    expect((await stateOf(other)).sync_enabled).toBe(true);
    expect((await stateOf(other)).notice_request_id).toBeNull();
  });

  it("keeps a first check a first check when queuing its reconcile notice fails", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock - DAY,
      purge_after: clock + 89 * DAY,
    });
    let reads = 0;
    const countingFetch = async (url: any, init: any) => {
      if (`${url}`.includes("/sync-retention/")) reads += 1;
      return fetch(url, init);
    };
    // The statement that records the state and queues the notice fails once
    // (e.g. the process dies there).
    let failNext = true;
    const db = {
      query: (sql: string, params?: any[]) => {
        if (failNext && /SET sync_enabled = \$2/.test(sql)) {
          failNext = false;
          return Promise.reject(new Error("connection lost"));
        }
        return getPool().query(sql, params);
      },
    };
    expect(
      await checkSyncStates({
        db: db as any,
        config,
        fetch: countingFetch as any,
        getLimits,
        now,
      }),
    ).toBe(0);
    expect(reads).toBe(1);
    let row = await stateOf(account_id);
    expect(row.sync_enabled).toBeNull();
    expect(row.notice_request_id).toBeNull();

    // The next eligible check asks Sagebrush again and queues the notice.
    clock += RECHECK_MS + 1;
    expect(
      await checkSyncStates({
        db: db as any,
        config,
        fetch: countingFetch as any,
        getLimits,
        now,
      }),
    ).toBe(1);
    expect(reads).toBe(2);
    row = await stateOf(account_id);
    expect(row.sync_enabled).toBe(true);
    expect(row.notice_request_id).not.toBeNull();
  });

  it("retries a first check when Sagebrush can't be read, without recording a baseline", async () => {
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    const down = async () => new Response("down", { status: 503 });
    expect(
      await checkSyncStates({ config, fetch: down as any, getLimits, now }),
    ).toBe(0);
    let row = await stateOf(account_id);
    expect(row.sync_enabled).toBeNull();
    expect(new Date(row.checked_at).valueOf()).toBe(clock);

    const { s, fetch } = fakeSagebrush();
    s.retention.set(account_id, {
      state: "readonly",
      readonly_since: clock - DAY,
      purge_after: clock + 89 * DAY,
    });
    clock += RECHECK_MS + 1;
    expect(await checkSyncStates({ config, fetch, getLimits, now })).toBe(1);
    row = await stateOf(account_id);
    expect(row.sync_enabled).toBe(true);
    expect(row.notice_request_id).not.toBeNull();
  });

  it("checks every due account in one pass, batch after batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const account_id = await insertAccount();
      enabled.set(account_id, i % 2 === 0);
      ids.push(account_id);
    }
    await checkSyncStates({ getLimits, now, batch: 2 });
    for (const [i, account_id] of ids.entries()) {
      expect((await stateOf(account_id)).sync_enabled).toBe(i % 2 === 0);
    }
  });

  it("backs off accounts whose check keeps failing, so the others are checked", async () => {
    const failing = [await insertAccount(), await insertAccount()];
    const ok = await insertAccount();
    enabled.set(ok, true);
    const accountState = async ({ account_id }: { account_id: string }) => {
      if (failing.includes(account_id)) throw new Error("bay unreachable");
      return getOAuthAccountStateLocal({ account_id });
    };
    // A batch as small as the failing accounts: without the backoff they
    // would be selected first on every pass.
    for (let i = 0; i < 2; i++) {
      await checkSyncStates({ getLimits, accountState, now, batch: 2 });
    }
    expect((await stateOf(ok)).sync_enabled).toBe(true);
    for (const account_id of failing) {
      const row = await stateOf(account_id);
      expect(row.sync_enabled).toBeNull();
      expect(new Date(row.checked_at).valueOf()).toBe(clock);
    }
    // And they are retried once RECHECK_MS has passed.
    failing.forEach((a) => enabled.set(a, false));
    clock += RECHECK_MS + 1;
    await checkSyncStates({ getLimits, now, batch: 2 });
    for (const account_id of failing) {
      expect((await stateOf(account_id)).sync_enabled).toBe(false);
    }
  });

  it("does not reschedule a notice that another pass got accepted meanwhile", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await syncedAccount(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    await checkSyncStates({ getLimits, now });
    // This pass's attempt fails, but while it was in flight (past its lease)
    // another pass sent the same notice and recorded its acceptance.
    const slowFailure = async (url: any, init: any) => {
      await getPool().query(
        `UPDATE sagebrush_sync_states
            SET notice_accepted_at = NOW(), notice_next_at = NULL
          WHERE account_id = $1`,
        [account_id],
      );
      return new Response("down", { status: 503 });
    };
    // A day overdue, and a 401: either would alert, had the notice still
    // been pending.
    await getPool().query(
      `UPDATE sagebrush_sync_states SET changed_at = changed_at - INTERVAL '2 days'
        WHERE account_id = $1`,
      [account_id],
    );
    const unauthorized = async (url: any, init: any) => {
      await slowFailure(url, init);
      return new Response("bad signature", { status: 401 });
    };
    const result = await deliverDueSyncNotices({
      config,
      fetch: unauthorized as any,
      now,
      getLimits,
    });
    expect(result).toEqual({ accepted: 0, failed: 0 });
    expect(mockAlert).not.toHaveBeenCalled();
    const row = await stateOf(account_id);
    expect(row.notice_accepted_at).not.toBeNull();
    expect(row.notice_next_at).toBeNull();
    // Nothing is due again.
    clock += DAY;
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    expect(s.notices).toHaveLength(0);
  });

  // A Sagebrush that applies a notice only if it is newer than the one it
  // holds, as the Worker does.
  function orderingSagebrush(held: { issued: number; enabled: boolean }) {
    const s = { held, notices: [] as any[] };
    const fetch = async (url: any, init: any) => {
      const path = new URL(`${url}`).pathname;
      if (path === "/api/admin/limits") {
        const n = JSON.parse(init.body);
        s.notices.push(n);
        const applied = n.issued > s.held.issued;
        if (applied) {
          s.held = { issued: n.issued, enabled: n.limits.sync.enabled };
        }
        return new Response(JSON.stringify({ applied }), { status: 200 });
      }
      const m = path.match(/^\/api\/admin\/sync-retention\/(.+)$/);
      if (m) {
        return new Response(
          JSON.stringify({
            account_id: m[1],
            state: s.held.enabled ? "active" : "readonly",
            readonly_since: s.held.enabled ? null : s.held.issued,
            purge_after: s.held.enabled ? null : s.held.issued + 90 * DAY,
            now: Date.now(),
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
    return { s, fetch: fetch as any };
  }

  it("sends a notice outranked by a skewed stamp again, until Sagebrush applies it", async () => {
    // The old home bay ended sync, its clock 2 minutes ahead of this one's;
    // the account renewed and signed in here soon after its rehome.
    const { s, fetch } = orderingSagebrush({
      issued: clock + 2 * 60_000,
      enabled: false,
    });
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await checkSyncStates({ config, fetch, getLimits, now });
    // The reconcile notice's stamp is earlier than the one Sagebrush holds.
    expect(
      await deliverDueSyncNotices({ config, fetch, now, getLimits }),
    ).toEqual({
      accepted: 0,
      failed: 1,
    });
    let row = await stateOf(account_id);
    expect(s.held.enabled).toBe(false);
    expect(row.notice_accepted_at).toBeNull();
    expect(row.last_error).toBe("notice_outranked 200");
    expect(Number(row.notice_issued)).toBe(
      new Date(row.notice_next_at).valueOf(),
    );

    for (let i = 0; i < 10 && row.notice_accepted_at == null; i++) {
      clock = new Date(row.notice_next_at).valueOf();
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      row = await stateOf(account_id);
    }
    expect(row.notice_accepted_at).not.toBeNull();
    expect(s.held.enabled).toBe(true);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("counts a notice Sagebrush didn't apply as delivered when its state is the notice's", async () => {
    const { s, fetch } = orderingSagebrush({
      issued: clock + 60 * 60_000,
      enabled: true,
    });
    const account_id = await insertAccount();
    enabled.set(account_id, true);
    await pass(fetch);
    enabled.set(account_id, false);
    clock += RECHECK_MS + 1;
    await checkSyncStates({ getLimits, now });
    // A newer renewal is held: this ending is stale, but Sagebrush is
    // read-only already, so it stands.
    s.held.enabled = false;
    expect(
      await deliverDueSyncNotices({ config, fetch, now, getLimits }),
    ).toEqual({
      accepted: 1,
      failed: 0,
    });
    expect((await stateOf(account_id)).email_stage).toBe("ended");
  });

  it("drops a pending notice the membership no longer matches, unsent", async () => {
    const { s, fetch } = fakeSagebrush();
    const account_id = await syncedAccount(fetch);
    lapse(s, account_id);
    await checkSyncStates({ getLimits, now });
    // Renewed before the notice went out (e.g. on a new home bay, after a
    // rehome left this notice here).
    enabled.set(account_id, true);
    expect(
      await deliverDueSyncNotices({ config, fetch, now, getLimits }),
    ).toEqual({ accepted: 0, failed: 0 });
    expect(s.notices).toHaveLength(0);
    let row = await stateOf(account_id);
    expect(row.notice_accepted_at).toBeNull();
    expect(row.notice_next_at).toBeNull();
    expect(row.last_error).toBe("notice_superseded");
    expect(row.email_stage).not.toBe("ended");

    // The next check here sees the change, and tells Sagebrush.
    clock += RECHECK_MS + 1;
    await pass(fetch);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0].limits.sync.enabled).toBe(true);
    row = await stateOf(account_id);
    expect(row.sync_enabled).toBe(true);
    expect(row.notice_accepted_at).not.toBeNull();
    expect(sent).toHaveLength(0);
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

  describe("CoCalc's own entitlement, before each email", () => {
    it("sends no first email when CoCalc sees a renewal Sagebrush hasn't yet", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      // Renewed after this pass's membership check; Sagebrush still says read-only.
      enabled.set(account_id, true);
      expect(await steps(fetch)).toMatchObject({ sent: 0, cancelled: 1 });
      const row = await stateOf(account_id);
      expect(row.email_stage).toBe("cancelled");
      expect(row.sync_enabled).toBe(true);
      // The renewal's notice is queued.
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      expect(s.notices).toHaveLength(2);
      expect(s.notices[1].limits.sync.enabled).toBe(true);
      clock += 100 * DAY;
      await pass(fetch);
      expect(sent).toHaveLength(0);
    });

    it("sends no second email when CoCalc sees a renewal Sagebrush hasn't yet", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      await steps(fetch);
      expect(sent).toHaveLength(1);
      clock = purge_after - BEFORE_DELETION_MS + 1;
      enabled.set(account_id, true);
      expect(await steps(fetch)).toMatchObject({ sent: 0, cancelled: 1 });
      expect(sent).toHaveLength(1);
      expect((await stateOf(account_id)).sync_enabled).toBe(true);
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      expect(s.notices.at(-1).limits.sync.enabled).toBe(true);
    });

    it("retries, and sends nothing, while the membership can't be resolved", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      expect(
        await steps(fetch, { getLimits: async () => undefined }),
      ).toMatchObject({ sent: 0, failed: 1 });
      let row = await stateOf(account_id);
      expect(row.email_stage).toBe("ended");
      expect(row.last_error).toBe("entitlement_unknown");
      clock += 10 * 60_000;
      await steps(fetch, {
        getLimits: async () => {
          throw Error("lookup failed");
        },
      });
      row = await stateOf(account_id);
      expect(row.email_attempts).toBe(2);
      expect(row.last_error).toBe("entitlement_unknown");
      expect(sent).toHaveLength(0);
      clock += 10 * 60_000;
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
    });
  });

  // A fetch whose retention reads wait until released.
  function holding(fetch: any) {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (reached = r));
    const held = async (url: any, init: any) => {
      if (new URL(`${url}`).pathname.startsWith("/api/admin/sync-retention/")) {
        reached();
        await released;
      }
      return fetch(url, init);
    };
    return { held: held as any, release, waiting };
  }

  // The pool, except that the first query matching `pattern` fails.
  function failingOnce(pattern: RegExp) {
    let failed = false;
    return {
      query: (sql: string, params?: any[]) => {
        if (!failed && pattern.test(sql)) {
          failed = true;
          return Promise.reject(Error("connection lost"));
        }
        return getPool().query(sql, params);
      },
    } as any;
  }

  // A getLimits that answers `answer` for one call, held until released.
  function heldLimits(answer: boolean) {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (reached = r));
    const held = async () => {
      reached();
      await released;
      return limits(answer);
    };
    return { held, release, waiting };
  }

  // Admin alerts as messages/send.ts records them: with dedupBySubject, an
  // alert with the subject of one recorded in the last 4 hours is dropped
  // (and the earlier one's id returned). `failNext` makes the next calls throw,
  // as adminAlert does with errorOnFail when the database is unreachable.
  function alertsRecorder() {
    const recorded: { subject: string; body: string; at: number }[] = [];
    let failNext = 0;
    const alert = async (opts: any) => {
      if (failNext > 0) {
        failNext -= 1;
        throw Error("database unreachable");
      }
      const earlier = recorded.findIndex(
        (m) =>
          m.subject === opts.subject &&
          (opts.dedupBySubject || m.body === opts.body) &&
          clock - m.at < 4 * 60 * 60_000,
      );
      if (earlier >= 0) return earlier + 1;
      recorded.push({ subject: opts.subject, body: opts.body, at: clock });
      return recorded.length;
    };
    return {
      alert: alert as any,
      recorded,
      failNext: (n: number) => (failNext = n),
    };
  }

  const unresolvedOf = async (account_id: string) =>
    (await deliveries(account_id)).find((d) => d.state === "unresolved");

  describe("renewals seen by a superseded pass", () => {
    it("an old pass's held renewal answer doesn't touch a newer cycle", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      // The first email's step asks CoCalc, and the answer (renewed) is held.
      const h = heldLimits(true);
      const old = steps(fetch, { getLimits: h.held });
      await h.waiting;
      // Meanwhile: renewed, then ended again, a new cycle and its first email.
      enabled.set(account_id, true);
      clock += RECHECK_MS + 1;
      await pass(fetch);
      lapse(s, account_id);
      await pass(fetch);
      expect(sent).toHaveLength(1);
      const current = await stateOf(account_id);
      expect(current.sync_enabled).toBe(false);
      expect(current.email_stage).toBe("before");
      const notices = s.notices.length;
      // The stale "renewed" answer arrives: nothing changes, no notice.
      h.release();
      expect(await old).toMatchObject({ cancelled: 0, stale: 1 });
      expect(await stateOf(account_id)).toEqual(current);
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      expect(s.notices).toHaveLength(notices);
    });

    it("a held renewal answer after the step was reclaimed changes nothing", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      const h = heldLimits(true);
      const old = steps(fetch, { getLimits: h.held });
      await h.waiting;
      clock += 5 * 60_000 + 1; // past the lease
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      const current = await stateOf(account_id);
      const notices = s.notices.length;
      h.release();
      expect(await old).toMatchObject({ cancelled: 0, stale: 1 });
      expect(await stateOf(account_id)).toEqual(current);
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      expect(s.notices).toHaveLength(notices);
    });
  });

  describe("cycles, claims and delivery records", () => {
    it("an old cycle's held step neither emails nor touches the new cycle", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      await steps(fetch);
      expect(sent).toHaveLength(1);
      const first = (await stateOf(account_id)).email_cycle;
      // The second email's step starts, and its read of Sagebrush is held.
      clock = purge_after - BEFORE_DELETION_MS + 1;
      const h = holding(fetch);
      const old = steps(h.held);
      await h.waiting;
      enabled.set(account_id, true);
      clock += RECHECK_MS + 1;
      await pass(fetch);
      lapse(s, account_id);
      await pass(fetch);
      expect(sent).toHaveLength(2);
      const current = await stateOf(account_id);
      expect(current.email_cycle).not.toBe(first);
      expect(current.email_stage).toBe("before");
      h.release();
      expect(await old).toMatchObject({ sent: 0, stale: 1 });
      expect(sent).toHaveLength(2);
      expect(await stateOf(account_id)).toEqual(current);
    });

    it("a pass whose cycle ends while it is held sends nothing, even with a resend pending", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      // An unresolved first attempt, which an admin chose to resend.
      await steps(fetch, {
        send: async () => {
          throw Error("connection reset");
        },
      });
      const unresolved = await unresolvedOf(account_id);
      expect(
        await resolveRetentionEmail({
          delivery_id: unresolved.delivery_id,
          decision: "resend",
        }),
      ).toBe(true);
      expect(await deliveries(account_id)).toMatchObject([
        { state: "pending", resolution: "resend" },
      ]);
      const h = holding(fetch);
      const old = steps(h.held);
      await h.waiting;
      // Renewed while that pass waits for Sagebrush (which hasn't heard yet).
      enabled.set(account_id, true);
      clock += RECHECK_MS + 1;
      await checkSyncStates({ getLimits, now });
      expect((await stateOf(account_id)).email_stage).toBe("cancelled");
      h.release();
      expect(await old).toMatchObject({ sent: 0, stale: 1 });
      expect(sent).toHaveLength(0);
      expect(await deliveries(account_id)).toMatchObject([
        { state: "pending", attempts: 1 },
      ]);
    });

    it("a step reclaimed after its lease isn't sent again by the former claimant", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      const h = holding(fetch);
      const old = steps(h.held);
      await h.waiting;
      clock += 5 * 60_000 + 1;
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      h.release();
      expect(await old).toMatchObject({ sent: 0, stale: 1 });
      expect(sent).toHaveLength(1);
      expect((await stateOf(account_id)).email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { stage: "ended", state: "sent", attempts: 1 },
      ]);
    });
  });

  describe("an email whose delivery is uncertain", () => {
    it("accepted, then the transport throws: not resent, not advanced, escalated; 'delivered' advances it", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      const acceptedThenThrew = async (message: any) => {
        sent.push(message); // the provider accepted it
        throw Error("socket closed before the reply");
      };
      expect(await steps(fetch, { send: acceptedThenThrew })).toMatchObject({
        sent: 0,
        unresolved: 1,
      });
      // Later passes neither resend nor advance it.
      for (let i = 0; i < 3; i++) {
        clock += 2 * 60 * 60_000;
        expect(await steps(fetch)).toMatchObject({ sent: 0, unresolved: 1 });
      }
      expect(sent).toHaveLength(1);
      let row = await stateOf(account_id);
      expect(row.email_stage).toBe("ended");
      expect(row.last_error).toBe("send_outcome_unknown");
      // The admins are told, about this delivery.
      const a = alertsRecorder();
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 1, failed: 0 });
      const { delivery_id } = await unresolvedOf(account_id);
      expect(a.recorded[0].subject).toContain(delivery_id);
      expect(a.recorded[0].body).toContain(account_id);
      // The provider shows it went out: the admin records that.
      await resolveRetentionEmail({ delivery_id, decision: "delivered" });
      expect(await steps(fetch)).toMatchObject({ sent: 0 });
      row = await stateOf(account_id);
      expect(row.email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { state: "sent", resolution: "delivered" },
      ]);
      // The second email still comes, once.
      clock = purge_after - BEFORE_DELETION_MS + 1;
      await steps(fetch);
      await steps(fetch);
      expect(sent).toHaveLength(2);
      expect(sent[1].subject).toMatch(/will be deleted on/);
    });

    it("a crash between admission and send: nothing sent, not advanced, escalated; 'resend' sends it once", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      // The pass is admitted, then never reaches the transport (it hangs
      // like a process that died there).
      let reachedSend!: () => void;
      const sending = new Promise<void>((r) => (reachedSend = r));
      void steps(fetch, {
        send: () => {
          reachedSend();
          return new Promise(() => {});
        },
      });
      await sending;
      expect(await deliveries(account_id)).toMatchObject([
        { state: "sending" },
      ]);
      clock += 5 * 60_000 + 1;
      expect(await steps(fetch)).toMatchObject({ sent: 0, unresolved: 1 });
      expect(sent).toHaveLength(0);
      expect((await stateOf(account_id)).email_stage).toBe("ended");
      const a = alertsRecorder();
      await escalateUnresolvedRetentionEmails({ now, alert: a.alert });
      expect(a.recorded).toHaveLength(1);
      const { delivery_id } = await unresolvedOf(account_id);
      await resolveRetentionEmail({ delivery_id, decision: "resend" });
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      await steps(fetch);
      expect(sent).toHaveLength(1);
      expect((await stateOf(account_id)).email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { state: "sent", attempts: 2, resolution: "resend" },
      ]);
    });

    it("a send still in flight past its lease isn't repeated, and its late success counts", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      let releaseSend!: () => void;
      let reachedSend!: () => void;
      const sendHeld = new Promise<void>((r) => (releaseSend = r));
      const sending = new Promise<void>((r) => (reachedSend = r));
      const slowSend = async (message: any) => {
        reachedSend();
        await sendHeld;
        sent.push(message);
      };
      const old = steps(fetch, { send: slowSend });
      await sending;
      clock += 5 * 60_000 + 1;
      expect(await steps(fetch)).toMatchObject({ sent: 0, unresolved: 1 });
      releaseSend();
      await old;
      expect(sent).toHaveLength(1);
      expect(await deliveries(account_id)).toMatchObject([{ state: "sent" }]);
      // Nothing left to escalate; the next look advances the step.
      const a = alertsRecorder();
      await escalateUnresolvedRetentionEmails({ now, alert: a.alert });
      expect(a.recorded).toHaveLength(0);
      clock += 60 * 60_000 + 1;
      await steps(fetch);
      expect((await stateOf(account_id)).email_stage).toBe("before");
      expect(sent).toHaveLength(1);
    });

    it("the escalation alert states the duplicate risk, and where to record the decision", async () => {
      const { s, fetch } = fakeSagebrush();
      await toFirstEmail(s, fetch);
      await steps(fetch, {
        send: async () => {
          throw Error("connection reset");
        },
      });
      const a = alertsRecorder();
      await escalateUnresolvedRetentionEmails({ now, alert: a.alert });
      const body = a.recorded[0].body.replace(/\s+/g, " ");
      expect(body).toContain(
        "A bay restart stops CoCalc-side work, but a provider may still finish an already-issued request. Without the provider's final outcome for that attempt, resending retains duplicate risk; accept it knowingly.",
      );
      expect(body).toContain(
        "in psql on this bay (the one that sent this alert, which holds the delivery record)",
      );
      expect(body).not.toMatch(/establish that it can't/);
    });

    it("the alert's psql decision works as written", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      await steps(fetch, {
        send: async () => {
          throw Error("connection reset");
        },
      });
      const a = alertsRecorder();
      await escalateUnresolvedRetentionEmails({ now, alert: a.alert });
      const resend = a.recorded[0].body.match(/If it didn't: (UPDATE [^\n]*;)/);
      expect(resend).not.toBeNull();
      await getPool().query(resend![1]);
      clock += 60 * 60_000 + 1; // "within the hour"
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      expect((await stateOf(account_id)).email_stage).toBe("before");
      const delivered = a.recorded[0].body.match(
        /If it went out: (UPDATE [^\n]*;)/,
      );
      expect(delivered).not.toBeNull();
    });

    it("an email whose success couldn't be recorded is escalated, not resent", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      expect(
        await steps(fetch, { db: failingOnce(/SET state = 'sent'/) }),
      ).toMatchObject({ sent: 1, failed: 1 });
      expect((await stateOf(account_id)).last_error).toBe("db_error");
      clock += 10 * 60_000;
      expect(await steps(fetch)).toMatchObject({ sent: 0, unresolved: 1 });
      expect(sent).toHaveLength(1);
      const a = alertsRecorder();
      await escalateUnresolvedRetentionEmails({ now, alert: a.alert });
      expect(a.recorded).toHaveLength(1);
      expect((await stateOf(account_id)).email_stage).toBe("ended");
    });

    it("escalations of two accounts in one dedup window are both delivered", async () => {
      const { s, fetch } = fakeSagebrush();
      const [one, two] = await toFirstEmails(s, fetch, 2);
      const reset = async () => {
        throw Error("connection reset");
      };
      expect(await steps(fetch, { send: reset })).toMatchObject({
        unresolved: 2,
      });
      const a = alertsRecorder();
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 2, failed: 0 });
      expect(a.recorded).toHaveLength(2);
      expect(a.recorded.map((m) => m.body).join()).toContain(one);
      expect(a.recorded.map((m) => m.body).join()).toContain(two);
      // A daily reminder each, until resolved.
      clock += 60 * 60_000;
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 0, failed: 0 });
      clock += DAY;
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 2, failed: 0 });
    });

    it("an escalation whose alert fails is retried until it is recorded", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      await steps(fetch, {
        send: async () => {
          throw Error("connection reset");
        },
      });
      const a = alertsRecorder();
      a.failNext(2);
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 0, failed: 1 });
      // (an alert "recorded" for nobody, with no admins, doesn't count either)
      clock += 10 * 60_000;
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 0, failed: 1 });
      clock += 10 * 60_000;
      expect(
        await escalateUnresolvedRetentionEmails({
          now,
          alert: (async () => undefined) as any,
        }),
      ).toEqual({ alerted: 0, failed: 1 });
      clock += 10 * 60_000;
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 1, failed: 0 });
      expect(a.recorded).toHaveLength(1);
      expect((await unresolvedOf(account_id)).escalated_at).not.toBeNull();
    });

    it("isn't escalated once its cycle is over", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      await steps(fetch, {
        send: async () => {
          throw Error("connection reset");
        },
      });
      enabled.set(account_id, true);
      clock += RECHECK_MS + 1;
      await checkSyncStates({ getLimits, now });
      const a = alertsRecorder();
      expect(
        await escalateUnresolvedRetentionEmails({ now, alert: a.alert }),
      ).toEqual({ alerted: 0, failed: 0 });
    });
  });

  describe("overdue alerts, per notice and per step", () => {
    const unresolvable = async () => {
      throw Error("lookup failed");
    };

    it("an overdue notice's alert doesn't silence the first email's", async () => {
      const { s, fetch } = fakeSagebrush();
      const account_id = await syncedAccount(fetch);
      lapse(s, account_id);
      s.noticeStatus = 503;
      await pass(fetch);
      clock += DAY + 1;
      await pass(fetch);
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockAlert.mock.calls[0][0].subject).toMatch(/notice/);
      s.noticeStatus = 200;
      clock += 7 * 60 * 60_000;
      await deliverDueSyncNotices({ config, fetch, now, getLimits });
      expect((await stateOf(account_id)).email_stage).toBe("ended");
      await steps(fetch, { getLimits: unresolvable });
      expect(mockAlert).toHaveBeenCalledTimes(1); // not overdue yet
      clock += DAY + 1;
      await steps(fetch, { getLimits: unresolvable });
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][0].subject).toMatch(
        /first retention email/,
      );
    });

    it("the first email's alert doesn't silence the second's", async () => {
      const { s, fetch } = fakeSagebrush();
      const { purge_after } = await toFirstEmail(s, fetch);
      await steps(fetch, { getLimits: unresolvable });
      clock += DAY + 1;
      await steps(fetch, { getLimits: unresolvable });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      clock += 7 * 60 * 60_000;
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      clock = purge_after - BEFORE_DELETION_MS + 1;
      await steps(fetch, { getLimits: unresolvable });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      clock += DAY + 1;
      await steps(fetch, { getLimits: unresolvable });
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][0].subject).toMatch(
        /second retention email/,
      );
    });

    it("two accounts overdue in one dedup window both get an alert", async () => {
      const { s, fetch } = fakeSagebrush();
      const [one, two] = await toFirstEmails(s, fetch, 2);
      const a = alertsRecorder();
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      clock += DAY + 1;
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      expect(a.recorded).toHaveLength(2);
      expect(a.recorded[0].subject).not.toBe(a.recorded[1].subject);
      expect(a.recorded.map((m) => m.subject).join()).toContain(one);
      expect(a.recorded.map((m) => m.subject).join()).toContain(two);
    });

    it("an overdue alert that fails is given on a later failure", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      const a = alertsRecorder();
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      clock += DAY + 1;
      a.failNext(1);
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      expect(a.recorded).toHaveLength(0);
      expect((await stateOf(account_id)).email_alerted_at).toBeNull();
      clock += 60 * 60_000;
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      expect(a.recorded).toHaveLength(1);
      expect((await stateOf(account_id)).email_alerted_at).not.toBeNull();
      clock += 60 * 60_000;
      await steps(fetch, { getLimits: unresolvable, alert: a.alert });
      expect(a.recorded).toHaveLength(1);
    });
  });

  describe("a rehome, and outages (the guarantee's stated cases)", () => {
    const moveAway = (account_id: string) =>
      getPool().query(
        "UPDATE accounts SET home_bay_id = 'bay-9' WHERE account_id = $1",
        [account_id],
      );
    // What the new home bay answers for the account.
    const liveElsewhere = async () => ({
      state: "live",
      email_address: "moved-account@example.com",
      email_verified: true,
      display_name: "",
    });

    it("a cycle pending on the old home bay is carried on after a rehome: both emails, once each", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      await moveAway(account_id);
      // (this bay's own view now says "moved"; the routed answer is the new home's)
      expect((await getOAuthAccountStateLocal({ account_id })).state).toBe(
        "moved",
      );
      mockRouted.mockImplementation(liveElsewhere);
      expect(await steps(fetch)).toMatchObject({ sent: 1, cancelled: 0 });
      expect(sent[0].to).toBe("moved-account@example.com");
      expect((await stateOf(account_id)).email_stage).toBe("before");
      clock = purge_after - BEFORE_DELETION_MS + 1;
      expect(await steps(fetch)).toMatchObject({ sent: 1, cancelled: 0 });
      await steps(fetch);
      expect(sent).toHaveLength(2);
      expect((await stateOf(account_id)).email_stage).toBe("done");
    });

    it("a rehome in progress is retried, never cancelled", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      await moveAway(account_id);
      mockRouted.mockImplementation(async () => {
        throw Error("account home bay is changing; try again");
      });
      expect(await steps(fetch)).toMatchObject({ sent: 0, failed: 1 });
      let row = await stateOf(account_id);
      expect(row.email_stage).toBe("ended");
      expect(row.last_error).toBe("account_state_unavailable");
      // (a bare "moved" answer is a retry too)
      clock += 10 * 60_000;
      mockRouted.mockImplementation(async () => ({
        state: "moved",
        home_bay_id: "bay-7",
      }));
      expect(await steps(fetch)).toMatchObject({ sent: 0, failed: 1 });
      expect((await stateOf(account_id)).email_stage).toBe("ended");
      clock += 10 * 60_000;
      mockRouted.mockImplementation(liveElsewhere);
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      row = await stateOf(account_id);
      expect(row.email_stage).toBe("before");
    });

    it("pins a stated zero-copy case: Sagebrush's read unavailable until the deletion date", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      const down = async (url: any, init: any) =>
        /sync-retention/.test(new URL(`${url}`).pathname)
          ? new Response("down", { status: 503 })
          : fetch(url, init);
      while (clock < purge_after) {
        await steps(down);
        clock += 7 * 24 * 60 * 60_000;
      }
      // (the admins were alerted while it was overdue)
      expect(
        mockAlert.mock.calls.some((c) =>
          /first retention email/.test(c[0].subject),
        ),
      ).toBe(true);
      // Back after the deletion date: nothing pending, so the cycle ends.
      expect(await steps(fetch)).toMatchObject({ sent: 0, cancelled: 1 });
      expect(sent).toHaveLength(0);
      expect(await deliveries(account_id)).toEqual([]);
    });

    it("pins a stated case: the 14 days count from when Sagebrush learned, not from a late first email", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      const down = async (url: any, init: any) =>
        /sync-retention/.test(new URL(`${url}`).pathname)
          ? new Response("down", { status: 503 })
          : fetch(url, init);
      while (clock < purge_after - DAY) {
        await steps(down);
        clock += 7 * 24 * 60 * 60_000;
        if (clock > purge_after - DAY) clock = purge_after - DAY;
        if (clock === purge_after - DAY) break;
      }
      // Sagebrush answers again one day before the deletion: the first email
      // goes, and the second at once, both naming the same, unchanged date.
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(2);
      expect((await stateOf(account_id)).email_stage).toBe("done");
      expect(new Date((await stateOf(account_id)).purge_after).valueOf()).toBe(
        purge_after,
      );
    });
  });

  it("keeps response bodies and exception text out of logs, alerts and the database", async () => {
    // Synthetic markers: an address and a credential-like token.
    const MARKERS = ["victim-7f3a@example.com", "tok_SYNTHETIC_c0ffee42"];
    const body = `{"error":"denied for ${MARKERS[0]}","token":"${MARKERS[1]}"}`;
    const { s, fetch } = fakeSagebrush();
    const leaky =
      (status: number, text: string, path: RegExp) =>
      async (url: any, init: any) =>
        path.test(new URL(`${url}`).pathname)
          ? new Response(text, { status })
          : fetch(url, init);
    const later = () => (clock += 7 * 60 * 60_000);
    const account_id = await syncedAccount(fetch);
    lapse(s, account_id);
    await checkSyncStates({ getLimits, now });
    // Notices refused, with the markers in the body (a 401 alerts at once).
    for (const [status, text] of [
      [401, body],
      [503, body],
      [200, `not json ${body}`],
    ] as const) {
      await deliverDueSyncNotices({
        config,
        fetch: leaky(status, text, /\/limits$/),
        now,
        getLimits,
      });
      later();
    }
    await deliverDueSyncNotices({ config, fetch, now, getLimits });
    expect((await stateOf(account_id)).email_stage).toBe("ended");
    // Retention reads failing the same ways.
    for (const [status, text] of [
      [401, body],
      [503, body],
      [200, `{"account_id":"${MARKERS[0]}",${body.slice(1)}`],
      [200, `{${body}`],
    ] as const) {
      await steps(leaky(status, text, /sync-retention/));
      later();
    }
    // A mail transport and a membership lookup failing with the markers.
    const markedError = () =>
      Error(`550 rejected ${MARKERS[0]} auth ${MARKERS[1]}`);
    await steps(fetch, {
      send: async () => {
        throw markedError();
      },
    });
    later();
    await steps(fetch, {
      getLimits: async () => {
        throw markedError();
      },
    });
    clock += 2 * DAY;
    await steps(fetch, {
      send: async () => {
        throw markedError();
      },
    });
    expect(sent).toHaveLength(0);
    await escalateUnresolvedRetentionEmails({ now });
    expect(mockAlert.mock.calls.map((c) => c[0].subject).join()).toMatch(
      /needs a decision/,
    );
    // (the failures were recorded and alerted, as codes)
    const codes = mockLogged.map((entry) => entry[2]?.code).filter(Boolean);
    for (const code of [
      "http_error",
      "malformed_response",
      "entitlement_unknown",
    ]) {
      expect(codes).toContain(code);
    }
    expect(mockAlert.mock.calls.length).toBeGreaterThanOrEqual(3);
    const seen = JSON.stringify({
      logged: mockLogged,
      alerts: mockAlert.mock.calls,
      states: (await getPool().query("SELECT * FROM sagebrush_sync_states"))
        .rows,
      emails: (await getPool().query("SELECT * FROM sagebrush_sync_emails"))
        .rows,
    });
    for (const marker of MARKERS) expect(seen).not.toContain(marker);
  });
});
