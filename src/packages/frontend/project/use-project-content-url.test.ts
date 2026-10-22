/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const issue = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      ensureProjectHostBrowserSessionForProject: async () => {},
      hub: { hosts: { issueProjectContentUrl: (opts: any) => issue(opts) } },
    },
  },
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { useProjectContentUrl } from "./use-project-content-url";

let n = 0;
// A new project each time: the hook remembers "off" per project for a while.
const project = () => `11111111-1111-4111-8111-${`${++n}`.padStart(12, "0")}`;

beforeEach(() => issue.mockReset());

it("uses the old behavior only on a site without content origins", async () => {
  issue.mockResolvedValue({ unavailable: "off" });
  const project_id = project();
  const { result } = renderHook(() =>
    useProjectContentUrl({ project_id, path: "/a.html" }),
  );
  await waitFor(() => expect(result.current.status).toBe("unavailable"));
});

it.each(["no-host", "host-not-ready", "other-bay"])(
  "%s: safe preview and retry, never the old behavior (the host may redirect raw HTML)",
  async (reason) => {
    issue.mockResolvedValue({ unavailable: reason });
    const project_id = project();
    const { result } = renderHook(() =>
      useProjectContentUrl({ project_id, path: "/a.html" }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
  },
);

it("viewers get no links", async () => {
  issue.mockResolvedValue({ unavailable: "no-access" });
  const project_id = project();
  const { result } = renderHook(() =>
    useProjectContentUrl({ project_id, path: "/a.html" }),
  );
  await waitFor(() => expect(result.current.status).toBe("no-access"));
});

it("a link", async () => {
  issue.mockResolvedValue({ url: "https://c.test/_c/x/files/a.html", expires_at: Date.now() + 3_600_000 });
  const project_id = project();
  const { result } = renderHook(() =>
    useProjectContentUrl({ project_id, path: "/a.html" }),
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
});

it("a host that stays not ready is asked less and less often", async () => {
  jest.useFakeTimers();
  try {
    issue.mockResolvedValue({ unavailable: "host-not-ready" });
    const project_id = project();
    const { result } = renderHook(() =>
      useProjectContentUrl({ project_id, path: "/a.html" }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(issue).toHaveBeenCalledTimes(1);
    // 30 s, then 60 s: the second retry must not come after another 30 s.
    // act() lets React re-render and run the retry effect before we look.
    const advance = async (ms: number) => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
    };
    await advance(30_000);
    expect(issue).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(issue).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(issue).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});
