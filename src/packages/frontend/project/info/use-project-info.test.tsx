/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { act, render } from "@testing-library/react";
import useProjectInfo from "./use-project-info";

jest.mock("react-interval-hook", () => ({
  useInterval: jest.fn(),
}));

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: () => "Project",
  }),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: "project",
  },
}));

const projectConat = jest.fn();
const getProjectInfo = jest.fn();

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
  get: (...args) => getProjectInfo(...args),
}));

function TestComponent({
  projectId = "project-1",
  onValue,
}: {
  projectId?: string;
  onValue?: (value: ReturnType<typeof useProjectInfo>) => void;
}) {
  const value = useProjectInfo({ project_id: projectId });
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

describe("useProjectInfo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    projectConat.mockResolvedValue({ client: "project" });
    getProjectInfo.mockResolvedValue({
      timestamp: Date.now(),
      processes: {},
      cgroup: null,
      disk_usage: null,
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
    expect(getProjectInfo).toHaveBeenCalledTimes(2);
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
    expect(getProjectInfo).toHaveBeenCalledTimes(2);
  });

  it("clears stale info when switching projects and the next load fails", async () => {
    const info1 = {
      timestamp: 1,
      processes: { 1: { pid: 1 } },
      cgroup: null,
      disk_usage: null,
    };
    projectConat
      .mockResolvedValueOnce({ client: "project-1" })
      .mockRejectedValueOnce(new Error("closed"));
    getProjectInfo.mockResolvedValueOnce(info1);
    let latest: ReturnType<typeof useProjectInfo> | undefined;

    const { rerender } = render(
      <TestComponent
        projectId="project-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.info).toEqual(info1);
    expect(latest?.disconnected).toBe(false);

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
        caller: "useProjectInfo",
      }),
    );
    expect(latest?.info).toBeNull();
    expect(latest?.disconnected).toBe(true);
  });

  it("ignores stale info responses from a previously selected project", async () => {
    const pendingProject1 = deferred<{ client: string }>();
    const info2 = {
      timestamp: 2,
      processes: { 2: { pid: 2 } },
      cgroup: null,
      disk_usage: null,
    };
    projectConat
      .mockReturnValueOnce(pendingProject1.promise)
      .mockResolvedValueOnce({ client: "project-2" });
    getProjectInfo.mockResolvedValueOnce(info2);

    let latest: ReturnType<typeof useProjectInfo> | undefined;
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

    expect(latest?.info).toEqual(info2);
    expect(latest?.disconnected).toBe(false);

    pendingProject1.resolve({ client: "project-1" });
    getProjectInfo.mockResolvedValueOnce({
      timestamp: 1,
      processes: { 1: { pid: 1 } },
      cgroup: null,
      disk_usage: null,
    });
    await flush();

    expect(latest?.info).toEqual(info2);
    expect(projectConat.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        project_id: "project-1",
        caller: "useProjectInfo",
      }),
    );
  });
});
