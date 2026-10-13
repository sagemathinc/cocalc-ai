/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import { purgeBackoffMs, sendPurgeRequest, signAdminRequest } from "./purge";

const purge = {
  url: "https://sagebrush.test/api/admin/purge",
  secret: "test-key",
};

describe("signAdminRequest", () => {
  it("matches the test vector in docs/sagebrush.md", () => {
    expect(
      signAdminRequest({
        secret: "test-key",
        timestamp: 1700000000,
        method: "POST",
        path: "/api/admin/purge",
        body: '{"account_id":"00000000-0000-4000-8000-000000000001","request_id":"00000000-0000-4000-8000-000000000002"}',
      }),
    ).toBe(
      "sha256=04c22a69c8bfd96f1d921273c8346c8f2edbc881244f7b401fe25ca41340d50c",
    );
  });

  it("binds the method and path", () => {
    const base = {
      secret: "k",
      timestamp: 1,
      method: "POST",
      path: "/a",
      body: "",
    };
    const signature = signAdminRequest(base);
    expect(signAdminRequest({ ...base, method: "GET" })).not.toBe(signature);
    expect(signAdminRequest({ ...base, path: "/b" })).not.toBe(signature);
  });
});

describe("purgeBackoffMs", () => {
  it("doubles from a minute up to six hours", () => {
    expect(purgeBackoffMs(1)).toBe(60_000);
    expect(purgeBackoffMs(2)).toBe(120_000);
    expect(purgeBackoffMs(9)).toBe(256 * 60_000);
    expect(purgeBackoffMs(10)).toBe(6 * 60 * 60_000);
    expect(purgeBackoffMs(1000)).toBe(6 * 60 * 60_000);
  });
});

describe("sendPurgeRequest", () => {
  const row = {
    account_id: "00000000-0000-4000-8000-000000000001",
    request_id: "00000000-0000-4000-8000-000000000002",
  };

  const ack = (request_id = row.request_id) =>
    new Response(JSON.stringify({ request_id, status: "accepted" }), {
      status: 202,
    });

  it("sends a signed request the receiver can verify", async () => {
    const fetch = jest.fn(async () => ack());
    const result = await sendPurgeRequest({
      purge,
      row,
      fetch: fetch as any,
      now: () => 1700000000_000,
    });
    expect(result).toEqual({ accepted: true, status: 202 });
    const [url, init] = fetch.mock.calls[0] as any[];
    expect(`${url}`).toBe("https://sagebrush.test/api/admin/purge");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(row));
    expect(init.headers["X-Sagebrush-Timestamp"]).toBe("1700000000");
    expect(init.headers["X-Sagebrush-Signature"]).toBe(
      "sha256=04c22a69c8bfd96f1d921273c8346c8f2edbc881244f7b401fe25ca41340d50c",
    );
  });

  it("reports anything but 202 as a failure", async () => {
    const fetch = jest.fn(
      async () => new Response("bad signature", { status: 401 }),
    );
    expect(await sendPurgeRequest({ purge, row, fetch: fetch as any })).toEqual(
      { status: 401, error: "HTTP 401: bad signature" },
    );
    const failing = jest.fn(async () => {
      throw new Error("connection refused");
    });
    expect(
      (await sendPurgeRequest({ purge, row, fetch: failing as any })).error,
    ).toContain("connection refused");
  });

  it("counts only the acknowledgment of this request as accepted", async () => {
    for (const response of [
      ack("00000000-0000-4000-8000-000000000099"),
      new Response("", { status: 202 }),
      new Response("<html>ok</html>", { status: 202 }),
      new Response(
        '{"request_id":"' + row.request_id + '","status":"queued"}',
        {
          status: 202,
        },
      ),
    ]) {
      const result = await sendPurgeRequest({
        purge,
        row,
        fetch: (async () => response) as any,
      });
      expect(result.accepted).toBeUndefined();
      expect(result.error).toMatch(/^HTTP 202 without an acknowledgment/);
    }
  });

  it("reads at most a few kilobytes of a response", async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(120));
      },
    });
    const result = await sendPurgeRequest({
      purge,
      row,
      fetch: (async () => new Response(body, { status: 500 })) as any,
    });
    expect(result.status).toBe(500);
    expect(result.error!.length).toBeLessThan(300);
    expect(pulled).toBeLessThan(10);
  });

  it("reports an invalid purge URL as this row's failure", async () => {
    const fetch = jest.fn();
    expect(
      (
        await sendPurgeRequest({
          purge: { url: "not a url", secret: "k" },
          row,
          fetch: fetch as any,
        })
      ).error,
    ).toMatch(/^request failed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails without a purge configuration", async () => {
    const fetch = jest.fn();
    expect(
      await sendPurgeRequest({
        purge: undefined,
        row,
        fetch: fetch as any,
      }),
    ).toEqual({ error: "purge is not configured for this client" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
