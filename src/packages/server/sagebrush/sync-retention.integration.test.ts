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
      sagebrush_sync_emails: SCHEMA.sagebrush_sync_emails,
    });
  });

  beforeEach(async () => {
    mockSettings = { site_name: "CoCalc" };
    mockAlert.mockReset();
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
    await deliverDueSyncNotices({ config, fetch, now });
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
    await deliverDueSyncNotices({ config, fetch, now });
    expect((await stateOf(account_id)).email_stage).toBe("ended");
    return { account_id, purge_after };
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
      await deliverDueSyncNotices({ config, fetch, now });
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
      await deliverDueSyncNotices({ config, fetch, now });
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
      // Meanwhile sync is renewed, then ends again: a new cycle, and its
      // first email.
      enabled.set(account_id, true);
      clock += RECHECK_MS + 1;
      await pass(fetch);
      lapse(s, account_id);
      await pass(fetch);
      expect(sent).toHaveLength(2);
      const current = await stateOf(account_id);
      expect(current.email_cycle).not.toBe(first);
      expect(current.email_stage).toBe("before");
      // The old step resumes, and changes nothing.
      h.release();
      expect(await old).toMatchObject({ sent: 0, stale: 1 });
      expect(sent).toHaveLength(2);
      expect(await stateOf(account_id)).toEqual(current);
    });

    it("a pass whose cycle ends while it is held sends nothing, even with a retry pending", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      // A refused first attempt leaves a delivery record that may be retried.
      await steps(fetch, {
        send: async () => {
          throw Error("refused");
        },
      });
      expect(await deliveries(account_id)).toMatchObject([{ state: "failed" }]);
      clock += 10 * 60_000;
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
        { state: "failed", attempts: 1 },
      ]);
    });

    it("a step reclaimed after its lease isn't sent again by the former claimant", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      const h = holding(fetch);
      const old = steps(h.held);
      await h.waiting;
      clock += 5 * 60_000 + 1; // past the lease
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      h.release();
      expect(await old).toMatchObject({ sent: 0, stale: 1 });
      expect(sent).toHaveLength(1);
      expect((await stateOf(account_id)).email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { stage: "ended", state: "sent", attempts: 1 },
      ]);
    });

    it("a send still in flight past its lease is not repeated: its outcome is unknown", async () => {
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
      expect(await steps(fetch)).toMatchObject({ sent: 0, unknown: 1 });
      expect(mockAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringMatching(/outcome unknown/),
        }),
      );
      releaseSend();
      await old;
      expect(sent).toHaveLength(1);
      const row = await stateOf(account_id);
      expect(row.email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { stage: "ended", state: "unknown" },
      ]);
    });

    it("an email whose outcome couldn't be recorded is not sent again", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id, purge_after } = await toFirstEmail(s, fetch);
      // The transport accepts the email; recording that fails.
      expect(
        await steps(fetch, { db: failingOnce(/SET state = 'sent'/) }),
      ).toMatchObject({ sent: 1, failed: 1 });
      let row = await stateOf(account_id);
      expect(row.email_stage).toBe("ended");
      expect(row.last_error).toBe("db_error");
      clock += 10 * 60_000;
      expect(await steps(fetch)).toMatchObject({ sent: 0, unknown: 1 });
      expect(sent).toHaveLength(1);
      row = await stateOf(account_id);
      expect(row.email_stage).toBe("before");
      expect(await deliveries(account_id)).toMatchObject([
        { stage: "ended", state: "unknown", attempts: 1 },
      ]);
      // The second email still comes, once.
      clock = purge_after - BEFORE_DELETION_MS + 1;
      await pass(fetch);
      await pass(fetch);
      expect(sent).toHaveLength(2);
      expect(sent[1].subject).toMatch(/will be deleted on/);
    });

    it("retries an email the transport refused, and sends it once", async () => {
      const { s, fetch } = fakeSagebrush();
      const { account_id } = await toFirstEmail(s, fetch);
      let calls = 0;
      const flaky = async (message: any) => {
        calls += 1;
        if (calls === 1) throw Error("421 try again later");
        sent.push(message);
      };
      expect(await steps(fetch, { send: flaky })).toMatchObject({
        sent: 0,
        failed: 1,
      });
      expect((await stateOf(account_id)).last_error).toBe("send_failed");
      expect(await deliveries(account_id)).toMatchObject([
        { state: "failed", attempts: 1 },
      ]);
      clock += 10 * 60_000;
      expect(await steps(fetch, { send: flaky })).toMatchObject({ sent: 1 });
      clock += 10 * 60_000;
      await steps(fetch, { send: flaky });
      expect(sent).toHaveLength(1);
      expect(calls).toBe(2);
      expect(await deliveries(account_id)).toMatchObject([
        { state: "sent", attempts: 2 },
      ]);
    });
  });

  describe("overdue alerts, per notice and per step", () => {
    const refuse = async () => {
      throw Error("refused");
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
      await deliverDueSyncNotices({ config, fetch, now });
      expect((await stateOf(account_id)).email_stage).toBe("ended");
      await steps(fetch, { send: refuse });
      expect(mockAlert).toHaveBeenCalledTimes(1); // not overdue yet
      clock += DAY + 1;
      await steps(fetch, { send: refuse });
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][0].subject).toMatch(
        /first retention email/,
      );
    });

    it("the first email's alert doesn't silence the second's", async () => {
      const { s, fetch } = fakeSagebrush();
      const { purge_after } = await toFirstEmail(s, fetch);
      await steps(fetch, { send: refuse });
      clock += DAY + 1;
      await steps(fetch, { send: refuse });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      clock += 7 * 60 * 60_000;
      expect(await steps(fetch)).toMatchObject({ sent: 1 });
      clock = purge_after - BEFORE_DELETION_MS + 1;
      await steps(fetch, { send: refuse });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      clock += DAY + 1;
      await steps(fetch, { send: refuse });
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][0].subject).toMatch(
        /second retention email/,
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
      });
      later();
    }
    await deliverDueSyncNotices({ config, fetch, now });
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
    // (the failures were recorded and alerted, as codes)
    const codes = mockLogged.map((entry) => entry[2]?.code).filter(Boolean);
    for (const code of [
      "http_error",
      "malformed_response",
      "send_failed",
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
