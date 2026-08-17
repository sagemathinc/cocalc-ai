/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getAccountProjectWindow, getAuthBootstrap } from "./api";

function response(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  } as Response;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/static/ultralite.html");
  global.fetch = jest.fn();
});

test("follows the advertised home bay for the authoritative project window", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(
      response({
        signed_in: true,
        account_id: "account-1",
        home_bay_url: "https://home.example.test",
      }),
    )
    .mockResolvedValueOnce(
      response({
        signed_in: true,
        account_id: "account-1",
        home_bay_url: "https://home.example.test",
        project_window: [{ project_id: "project-1", title: "Project" }],
        project_window_has_more: false,
      }),
    );

  const value = await getAuthBootstrap();

  expect(value.project_window).toHaveLength(1);
  expect(jest.mocked(fetch)).toHaveBeenNthCalledWith(
    2,
    "https://home.example.test/api/v2/auth/bootstrap",
    expect.objectContaining({ credentials: "include" }),
  );
});

test("uses the bootstrap window without a second request on the home bay", async () => {
  jest.mocked(fetch).mockResolvedValueOnce(
    response({
      signed_in: true,
      account_id: "account-1",
      home_bay_url: "https://home.example.test",
      project_window: [],
      project_window_has_more: false,
    }),
  );

  await expect(getAuthBootstrap()).resolves.toEqual(
    expect.objectContaining({ project_window: [] }),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("keeps later project-window reads on the home bay", async () => {
  jest.mocked(fetch).mockResolvedValueOnce(
    response({
      signed_in: true,
      account_id: "account-1",
      project_window: [{ project_id: "project-2" }],
      project_window_has_more: true,
    }),
  );

  await expect(
    getAccountProjectWindow({
      bootstrap: {
        signed_in: true,
        account_id: "account-1",
        home_bay_url: "https://home.example.test",
      },
      request: { limit: 50, offset: 50, search: "algebra" },
    }),
  ).resolves.toEqual({
    hasMore: true,
    projects: [{ project_id: "project-2" }],
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://home.example.test/api/v2/auth/bootstrap",
    expect.objectContaining({
      body: JSON.stringify({
        project_window: { limit: 50, offset: 50, search: "algebra" },
      }),
      credentials: "include",
    }),
  );
});
