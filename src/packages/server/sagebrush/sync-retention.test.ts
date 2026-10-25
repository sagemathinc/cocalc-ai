/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import { createHmac } from "node:crypto";

import {
  deletionPending,
  deliveryId,
  getSyncNoticeConfig,
  readSyncRetention,
  retentionEmail,
  sendSyncNotice,
} from "./sync-retention";

const config = { origin: "https://sagebrush.test", secret: "limits-key" };
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const limits = {
  tier: "free",
  storage_bytes: 1000,
  max_file_bytes: 100,
  private_links: false,
  sync: {
    enabled: false,
    version_bytes: 0,
    read_bytes_per_day: 0,
    retention_days: 90,
  },
};

// What the Worker checks (web/share/server.ts signedWith): HMAC-SHA256 of
// timestamp, method, path and body, joined by newlines.
function verifies(url: string, init: any, body: string): boolean {
  const ts = init.headers["X-Sagebrush-Timestamp"];
  const want = `sha256=${createHmac("sha256", config.secret)
    .update(`${ts}\n${init.method}\n${new URL(url).pathname}\n${body}`)
    .digest("hex")}`;
  return init.headers["X-Sagebrush-Signature"] === want;
}

describe("getSyncNoticeConfig", () => {
  it("is off without the limits key", async () => {
    mockSettings = {};
    expect(await getSyncNoticeConfig()).toBeUndefined();
  });

  it("uses the purge URL's origin (the default one when unset)", async () => {
    mockSettings = { sagebrush_limits_secret: " k " };
    expect(await getSyncNoticeConfig()).toEqual({
      origin: "https://sagebrush.space",
      secret: "k",
    });
    mockSettings = {
      sagebrush_limits_secret: "k",
      sagebrush_purge_url: "https://dev.sagebrush.test/api/admin/purge",
    };
    expect((await getSyncNoticeConfig())?.origin).toBe(
      "https://dev.sagebrush.test",
    );
  });

  it("is off with a blank or disallowed purge URL", async () => {
    mockSettings = { sagebrush_limits_secret: "k", sagebrush_purge_url: "" };
    expect(await getSyncNoticeConfig()).toBeUndefined();
    mockSettings = {
      sagebrush_limits_secret: "k",
      sagebrush_purge_url: "http://sagebrush.test/api/admin/purge",
    };
    expect(await getSyncNoticeConfig()).toBeUndefined();
  });
});

describe("sendSyncNotice", () => {
  const notice = {
    request_id: "00000000-0000-4000-8000-000000000002",
    account_id: ACCOUNT,
    issued: 1_700_000_000_123,
    limits,
  };

  it("sends a signed notice the Worker can verify", async () => {
    const fetch = jest.fn(async (url: any, init: any) => {
      expect(`${url}`).toBe("https://sagebrush.test/api/admin/limits");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(notice);
      expect(verifies(`${url}`, init, init.body)).toBe(true);
      return new Response(JSON.stringify({ applied: true }), { status: 200 });
    });
    expect(
      await sendSyncNotice({ config, notice, fetch: fetch as any }),
    ).toEqual({ accepted: true, status: 200 });
  });

  it("counts a notice not applied (older, or no synced data) as delivered", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ applied: false }), { status: 200 });
    expect(
      (await sendSyncNotice({ config, notice, fetch: fetch as any })).accepted,
    ).toBe(true);
  });

  it("fails on anything else, with a code and status only", async () => {
    for (const [response, message] of [
      [new Response("bad signature", { status: 401 }), "http_error 401"],
      [new Response("{}", { status: 200 }), "malformed_response 200"],
      [new Response("<html>", { status: 200 }), "malformed_response 200"],
    ] as const) {
      const r = await sendSyncNotice({
        config,
        notice,
        fetch: (async () => response) as any,
      });
      expect(r.accepted).toBeUndefined();
      expect(r.failure?.message).toBe(message);
    }
    const thrown = await sendSyncNotice({
      config,
      notice,
      fetch: (async () => {
        throw Error("down for someone@example.com");
      }) as any,
    });
    expect(thrown.failure?.code).toBe("request_failed");
    expect(thrown.failure?.message).toBe("request_failed");
  });
});

describe("readSyncRetention", () => {
  it("sends a signed GET with an empty body and reads the answer", async () => {
    const fetch = jest.fn(async (url: any, init: any) => {
      expect(`${url}`).toBe(
        `https://sagebrush.test/api/admin/sync-retention/${ACCOUNT}`,
      );
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(verifies(`${url}`, init, "")).toBe(true);
      return new Response(
        JSON.stringify({
          account_id: ACCOUNT,
          state: "readonly",
          readonly_since: 1000,
          purge_after: 2000,
          now: 1500,
        }),
        { status: 200 },
      );
    });
    expect(
      await readSyncRetention({
        config,
        account_id: ACCOUNT,
        fetch: fetch as any,
      }),
    ).toEqual({
      synced: true,
      state: "readonly",
      readonly_since: 1000,
      purge_after: 2000,
    });
  });

  it("reads a 404 as no synced data", async () => {
    const fetch = async () => new Response("never synced", { status: 404 });
    expect(
      await readSyncRetention({
        config,
        account_id: ACCOUNT,
        fetch: fetch as any,
      }),
    ).toEqual({ synced: false });
  });

  it("throws on an error or a malformed answer", async () => {
    for (const response of [
      new Response("nope", { status: 401 }),
      new Response(JSON.stringify({ account_id: "other", state: "readonly" }), {
        status: 200,
      }),
      new Response(
        JSON.stringify({
          account_id: ACCOUNT,
          state: "readonly",
          purge_after: "soon",
        }),
        { status: 200 },
      ),
      new Response("{not json", { status: 200 }),
    ]) {
      await expect(
        readSyncRetention({
          config,
          account_id: ACCOUNT,
          fetch: (async () => response) as any,
        }),
      ).rejects.toThrow(/^(http_error 401|malformed_response 200)$/);
    }
  });
});

describe("deliveryId", () => {
  const cycle = "00000000-0000-4000-8000-000000000003";
  it("is one stable UUID per email of a cycle", () => {
    expect(deliveryId(cycle, "ended")).toBe(deliveryId(cycle, "ended"));
    expect(deliveryId(cycle, "ended")).not.toBe(deliveryId(cycle, "before"));
    expect(deliveryId(cycle, "ended")).not.toBe(
      deliveryId("00000000-0000-4000-8000-000000000004", "ended"),
    );
    expect(deliveryId(cycle, "before")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("deletionPending", () => {
  it("is true only for read-only data with a deletion date ahead", () => {
    const r = (o: any) => ({
      synced: true,
      state: "readonly",
      readonly_since: 1,
      purge_after: 100,
      ...o,
    });
    expect(deletionPending(r({}), 50)).toBe(true);
    expect(deletionPending(r({}), 100)).toBe(false);
    expect(
      deletionPending(r({ state: "active", readonly_since: null }), 50),
    ).toBe(false);
    expect(deletionPending(r({ readonly_since: null }), 50)).toBe(false);
    expect(deletionPending({ synced: false }, 50)).toBe(false);
  });
});

describe("retentionEmail", () => {
  const purge_after = Date.UTC(2027, 0, 23, 12);
  it("says sync ended, the data is read-only, and when it is deleted", () => {
    const e = retentionEmail({
      stage: "ended",
      purge_after,
      site_name: "CoCalc",
      sagebrush: "https://sagebrush.space",
    });
    expect(e.subject).toMatch(/sync has ended/);
    expect(e.text).toMatch(/read-only/);
    expect(e.text).toContain("January 23, 2027 (UTC)");
    expect(e.text).toContain("https://sagebrush.space");
    expect(e.text).toMatch(/email you again/);
  });

  it("warns before deletion, with the date in the subject", () => {
    const e = retentionEmail({
      stage: "before",
      purge_after,
      site_name: "CoCalc",
      sagebrush: "https://sagebrush.space",
    });
    expect(e.subject).toBe(
      "Your Sagebrush synced data will be deleted on January 23, 2027",
    );
    expect(e.text).toContain("January 23, 2027 (UTC)");
  });

  it("escapes the html", () => {
    const e = retentionEmail({
      stage: "ended",
      purge_after,
      site_name: "<b>Site</b>",
      sagebrush: "https://sagebrush.space",
    });
    expect(e.html).toContain("&lt;b&gt;Site&lt;/b&gt;");
    expect(e.html).not.toContain("<b>");
  });
});
