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
import type { OAuthClient } from "./clients";

const client: OAuthClient = {
  client_id: "sagebrush",
  name: "Sagebrush",
  homepage: "https://sagebrush.space",
  client_secret: "s",
  redirect_uris: [],
  purge: { url: "https://sagebrush.test/api/admin/purge", secret: "test-key" },
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

  it("sends a signed request the receiver can verify", async () => {
    const fetch = jest.fn(async () => new Response("{}", { status: 202 }));
    const result = await sendPurgeRequest({
      client,
      row,
      fetch: fetch as any,
      now: () => 1700000000_000,
    });
    expect(result).toEqual({ status: 202 });
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
    expect(
      await sendPurgeRequest({ client, row, fetch: fetch as any }),
    ).toEqual({ status: 401, error: "HTTP 401: bad signature" });
    const failing = jest.fn(async () => {
      throw new Error("connection refused");
    });
    expect(
      (await sendPurgeRequest({ client, row, fetch: failing as any })).error,
    ).toContain("connection refused");
  });

  it("fails without a purge configuration", async () => {
    const fetch = jest.fn();
    expect(
      await sendPurgeRequest({
        client: { ...client, purge: undefined },
        row,
        fetch: fetch as any,
      }),
    ).toEqual({ error: "purge is not configured for this client" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
