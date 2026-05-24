/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockFileAccess = jest.fn();
const mockFilenameSearch = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/projects/document-activity", () => ({
  fileAccess: (...args) => mockFileAccess(...args),
  filenameSearch: (...args) => mockFilenameSearch(...args),
}));

describe("browser file activity API-key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockFileAccess.mockReset().mockResolvedValue([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Private project",
        path: "private.ipynb",
      },
    ]);
    mockFilenameSearch.mockReset().mockResolvedValue([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        filename: "private.ipynb",
        time: new Date("2026-05-23T00:00:00.000Z"),
      },
    ]);
  });

  it("rejects API-key access to recent file activity", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { interval: "1 day" },
    });

    const { default: handler } = await import("./file-access");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to access browser file activity",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockFileAccess).not.toHaveBeenCalled();
  });

  it("keeps browser-session access to recent file activity", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { interval: "1 day" },
    });

    const { default: handler } = await import("./file-access");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      files: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          title: "Private project",
          path: "private.ipynb",
        },
      ],
    });
    expect(mockFileAccess).toHaveBeenCalledWith({
      account_id: "acct-1",
      interval: "1 day",
    });
  });

  it("rejects API-key access to filename search", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { search: "private" },
    });

    const { default: handler } = await import("./projects/filename-search");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to access browser file activity",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockFilenameSearch).not.toHaveBeenCalled();
  });

  it("keeps browser-session filename search", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { search: "private" },
    });

    const { default: handler } = await import("./projects/filename-search");
    await handler(req, res);

    expect(res._getJSONData()).toEqual([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        filename: "private.ipynb",
        time: "2026-05-23T00:00:00.000Z",
      },
    ]);
    expect(mockFilenameSearch).toHaveBeenCalledWith({
      search: "private",
      account_id: "acct-1",
    });
  });
});
