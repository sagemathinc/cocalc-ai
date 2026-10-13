/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));

import {
  authenticateOAuthClient,
  getOAuthClient,
  getOAuthClientPurgeConfig,
  getOAuthPurgeTargets,
  isRegisteredRedirectUri,
  parseBasicAuthorization,
  parseRedirectUris,
} from "./clients";

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

describe("OAuth client registry", () => {
  beforeEach(() => {
    mockSettings = { sagebrush_client_secret: "s3cret" };
  });

  it("is off while the client secret is blank", async () => {
    mockSettings = { sagebrush_client_secret: "  " };
    expect(await getOAuthClient("sagebrush")).toBeUndefined();
  });

  it("knows only registered clients", async () => {
    expect(await getOAuthClient("other")).toBeUndefined();
    expect(await getOAuthClient("__proto__")).toBeUndefined();
    expect(await getOAuthClient(undefined)).toBeUndefined();
  });

  it("uses the default redirect URI and purge URL when the settings are absent", async () => {
    const client = await getOAuthClient("sagebrush");
    expect(client).toMatchObject({
      client_id: "sagebrush",
      redirect_uris: ["https://sagebrush.space/auth/callback"],
    });
    // No purge key, so no purge requests.
    expect(client?.purge).toBeUndefined();
    mockSettings.sagebrush_purge_secret = "k";
    expect((await getOAuthClient("sagebrush"))?.purge).toEqual({
      url: "https://sagebrush.space/api/admin/purge",
      secret: "k",
    });
  });

  it("finds purge configuration and targets independently of sign-in", async () => {
    mockSettings = { sagebrush_purge_secret: "k" };
    expect(await getOAuthClient("sagebrush")).toBeUndefined();
    expect(await getOAuthClientPurgeConfig("sagebrush")).toEqual({
      url: "https://sagebrush.space/api/admin/purge",
      secret: "k",
    });
    expect(await getOAuthPurgeTargets()).toEqual(["sagebrush"]);
    mockSettings = { sagebrush_client_secret: "s" };
    expect(await getOAuthClientPurgeConfig("sagebrush")).toBeUndefined();
    expect(await getOAuthPurgeTargets()).toEqual(["sagebrush"]);
    mockSettings = {};
    expect(await getOAuthPurgeTargets()).toEqual([]);
    expect(await getOAuthClientPurgeConfig("__proto__")).toBeUndefined();
  });

  it("ignores a purge URL that is not https", async () => {
    mockSettings.sagebrush_purge_secret = "k";
    for (const url of [
      "http://sagebrush.space/api/admin/purge",
      "https://u:p@sagebrush.space/api/admin/purge",
      "not a url",
    ]) {
      mockSettings.sagebrush_purge_url = url;
      expect((await getOAuthClient("sagebrush"))?.purge).toBeUndefined();
    }
    mockSettings.sagebrush_purge_url = "http://localhost:8787/api/admin/purge";
    expect((await getOAuthClient("sagebrush"))?.purge?.url).toBe(
      "http://localhost:8787/api/admin/purge",
    );
  });

  it("reads one redirect URI per line and matches them exactly", async () => {
    mockSettings.sagebrush_redirect_uris =
      "https://dev.sagebrush.space/auth/callback\nhttp://localhost:8787/auth/callback\n";
    const client = (await getOAuthClient("sagebrush"))!;
    expect(client.redirect_uris).toEqual([
      "https://dev.sagebrush.space/auth/callback",
      "http://localhost:8787/auth/callback",
    ]);
    expect(
      isRegisteredRedirectUri(client, "http://localhost:8787/auth/callback"),
    ).toBe(true);
    for (const uri of [
      "http://localhost:8787/auth/callback/",
      "http://localhost:8787/auth/callback?x=1",
      "https://sagebrush.space/auth/callback",
      "HTTP://localhost:8787/auth/callback",
    ]) {
      expect(isRegisteredRedirectUri(client, uri)).toBe(false);
    }
  });

  it("drops redirect URIs that are not plain https URLs", () => {
    expect(
      parseRedirectUris(
        "javascript:alert(1) https://a.test/cb#frag https://u:p@a.test/cb /relative https://ok.test/cb",
      ),
    ).toEqual(["https://ok.test/cb"]);
  });

  it("allows http only for a loopback host", () => {
    expect(
      parseRedirectUris(
        "http://localhost:8787/cb http://127.0.0.1:8787/cb http://[::1]:8787/cb http://sagebrush.space/cb http://localhost.evil.test/cb",
      ),
    ).toEqual([
      "http://localhost:8787/cb",
      "http://127.0.0.1:8787/cb",
      "http://[::1]:8787/cb",
    ]);
  });

  it("parses Basic credentials, form-decoding the id and secret", () => {
    expect(parseBasicAuthorization(basic("sagebrush", "a%2Bb+c"))).toEqual({
      client_id: "sagebrush",
      client_secret: "a+b c",
    });
    expect(parseBasicAuthorization("Bearer abc")).toBeUndefined();
    expect(parseBasicAuthorization(basic("", "x"))).toBeUndefined();
    expect(parseBasicAuthorization(undefined)).toBeUndefined();
  });

  it("authenticates the client only with the right secret", async () => {
    expect(
      (await authenticateOAuthClient(basic("sagebrush", "s3cret")))?.client_id,
    ).toBe("sagebrush");
    expect(
      await authenticateOAuthClient(basic("sagebrush", "s3cret2")),
    ).toBeUndefined();
    expect(
      await authenticateOAuthClient(basic("other", "s3cret")),
    ).toBeUndefined();
  });
});
