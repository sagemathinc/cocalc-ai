/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { act, render } from "@testing-library/react";
import useProjectInfoHistory from "./use-project-info-history";

jest.mock("react-interval-hook", () => ({
  useInterval: jest.fn(),
}));

const projectConat = jest.fn();
const getProjectInfoHistory = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => {
  const { EventEmitter } = require("events");
  const conat_client = Object.assign(new EventEmitter(), {
    removeListener: EventEmitter.prototype.removeListener,
    projectConat: (...args) => projectConat(...args),
  });
  return {
    webapp_client: {
      conat_client,
    },
  };
});

jest.mock("@cocalc/conat/project/project-info", () => ({
  getHistory: (...args) => getProjectInfoHistory(...args),
}));

function TestComponent({
  projectId = "project-1",
  onValue,
}: {
  projectId?: string;
  onValue?: (value: ReturnType<typeof useProjectInfoHistory>) => void;
}) {
  const value = useProjectInfoHistory({ project_id: projectId });
  onValue?.(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useProjectInfoHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    projectConat.mockResolvedValue({ client: "project" });
    getProjectInfoHistory.mockResolvedValue({
      timestamp: Date.now(),
      cpu: [],
      mem: [],
    });
  });

  it("refreshes when the conat client reconnects", async () => {
    const { webapp_client } = jest.requireMock(
      "@cocalc/frontend/webapp-client",
    ) as {
      webapp_client: {
        conat_client: EventEmitter & {
          projectConat: jest.Mock;
          removeListener: typeof EventEmitter.prototype.removeListener;
        };
      };
    };

    render(<TestComponent />);
    await flush();
    expect(projectConat).toHaveBeenCalledTimes(1);

    act(() => {
      webapp_client.conat_client.emit("connected");
    });
    await flush();

    expect(projectConat).toHaveBeenCalledTimes(2);
    expect(getProjectInfoHistory).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a hidden tab becomes visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    render(<TestComponent />);
    await flush();
    expect(projectConat).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(projectConat).toHaveBeenCalledTimes(2);
    expect(getProjectInfoHistory).toHaveBeenCalledTimes(2);
  });

  it("clears stale history when switching projects and the next load fails", async () => {
    const history1 = {
      timestamp: 1,
      cpu: [1],
      mem: [2],
    };
    projectConat
      .mockResolvedValueOnce({ client: "project-1" })
      .mockRejectedValueOnce(new Error("closed"));
    getProjectInfoHistory.mockResolvedValueOnce(history1);
    let latest: ReturnType<typeof useProjectInfoHistory> | undefined;

    const { rerender } = render(
      <TestComponent
        projectId="project-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.history).toEqual(history1);

    rerender(
      <TestComponent
        projectId="project-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(projectConat.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        project_id: "project-2",
        caller: "useProjectInfoHistory",
      }),
    );
    expect(latest?.history).toBeNull();
  });

  it("ignores stale history responses from a previously selected project", async () => {
    const pendingProject1 = deferred<{ client: string }>();
    const history2 = {
      timestamp: 2,
      cpu: [2],
      mem: [3],
    };
    projectConat
      .mockReturnValueOnce(pendingProject1.promise)
      .mockResolvedValueOnce({ client: "project-2" });
    getProjectInfoHistory.mockResolvedValueOnce(history2);

    let latest: ReturnType<typeof useProjectInfoHistory> | undefined;
    const { rerender } = render(
      <TestComponent
        projectId="project-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    rerender(
      <TestComponent
        projectId="project-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.history).toEqual(history2);

    pendingProject1.resolve({ client: "project-1" });
    getProjectInfoHistory.mockResolvedValueOnce({
      timestamp: 1,
      cpu: [1],
      mem: [1],
    });
    await flush();

    expect(latest?.history).toEqual(history2);
    expect(projectConat.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        project_id: "project-1",
        caller: "useProjectInfoHistory",
      }),
    );
  });
});
