/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getStorageOverview from "./storage-overview";

const mockProjectConat = jest.fn();
const mockGetProjectStorageOverview = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: (...args) => mockProjectConat(...args),
    },
  },
}));

jest.mock("@cocalc/conat/project/storage-info", () => ({
  getStorageOverview: (...args) => mockGetProjectStorageOverview(...args),
}));

function overview() {
  return {
    collected_at: "2026-05-11T12:00:00.000Z",
    quotas: [],
    live: null,
    retained: null,
    visible: [],
  };
}

describe("getStorageOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("times out and clears stalled in-flight overview requests", async () => {
    jest.useFakeTimers();
    mockProjectConat.mockReturnValueOnce(new Promise(() => undefined));
    const first = getStorageOverview({
      project_id: "project-timeout",
      home: "/home/user",
      cache: false,
    });
    const firstResult = expect(first).rejects.toThrow("timeout");

    try {
      await jest.advanceTimersByTimeAsync(15_000);
      await firstResult;
    } finally {
      jest.useRealTimers();
    }

    const nextOverview = overview();
    mockProjectConat.mockResolvedValueOnce({ client: "project" });
    mockGetProjectStorageOverview.mockResolvedValueOnce(nextOverview);

    await expect(
      getStorageOverview({
        project_id: "project-timeout",
        home: "/home/user",
        cache: false,
      }),
    ).resolves.toBe(nextOverview);
    expect(mockProjectConat).toHaveBeenCalledTimes(2);
  });
});
