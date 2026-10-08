/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  GithubReconnectRequired,
  pollGithubDeviceLogin,
  refreshGithubConnection,
  startGithubDeviceLogin,
} from "./cli-connector-github";

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));

const config = {
  client_id: "Iv23test",
  client_secret: "secret",
  app_url: "https://github.com/apps/cocalc-test",
};
const reply = (body: unknown) =>
  jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as any;
const login = {
  version: 1 as const,
  type: "github-device-login" as const,
  client_id: "Iv23test",
  device_code: "dev",
  expires_at: Date.now() + 600_000,
};

it("explains an app without Device Flow", async () => {
  await expect(
    startGithubDeviceLogin({
      config,
      fetchImpl: reply({ error: "device_flow_disabled" }),
    }),
  ).rejects.toThrow("does not have Device Flow enabled");
});

it("only accepts a verification page on github.com", async () => {
  await expect(
    startGithubDeviceLogin({
      config,
      fetchImpl: reply({
        device_code: "dev",
        user_code: "ABCD-1234",
        verification_uri: "https://evil.example/login/device",
      }),
    }),
  ).rejects.toThrow("unexpected response");
});

it("never polls faster than GitHub's minimum", async () => {
  const started = await startGithubDeviceLogin({
    config,
    fetchImpl: reply({
      device_code: "dev",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 1,
    }),
  });
  expect(started.interval).toBe(5);
});

it.each([
  ["slow_down", { status: "pending", slow_down: true }],
  ["access_denied", { status: "denied" }],
  ["expired_token", { status: "expired" }],
])("maps %s", async (error, expected) => {
  await expect(
    pollGithubDeviceLogin({ config, login, fetchImpl: reply({ error }) }),
  ).resolves.toEqual(expected);
});

it("a sign-in started with another app is expired", async () => {
  const fetchImpl = reply({});
  await expect(
    pollGithubDeviceLogin({
      config: { ...config, client_id: "Iv23other" },
      login,
      fetchImpl,
    }),
  ).resolves.toEqual({ status: "expired" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

describe("refresh", () => {
  const connection = {
    version: 2 as const,
    type: "github-app" as const,
    client_id: "Iv23test",
    access_token: "ghu",
    access_expires_at: 10_000_000,
    refresh_token: "ghr",
    refresh_expires_at: 20_000_000,
  };

  it("keeps a token with time left, without calling GitHub", async () => {
    const fetchImpl = reply({});
    await expect(
      refreshGithubConnection({ config, connection, now: 0, fetchImpl }),
    ).resolves.toEqual({ connection, refreshed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a new sign-in once the refresh token expired", async () => {
    await expect(
      refreshGithubConnection({
        config,
        connection,
        now: 20_000_000,
        fetchImpl: reply({}),
      }),
    ).rejects.toBeInstanceOf(GithubReconnectRequired);
  });

  it("a transient GitHub error is not a reason to sign in again", async () => {
    const error = await refreshGithubConnection({
      config,
      connection,
      now: 9_999_000,
      fetchImpl: reply({ error: "server_error" }),
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GithubReconnectRequired);
  });
});
