/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHostProjects } from "./use-host-projects";

const listHostProjects = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        hosts: {
          listHostProjects: (...args) => listHostProjects(...args),
        },
      },
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function TestComponent({
  hostId,
  riskOnly = false,
  onValue,
}: {
  hostId?: string;
  riskOnly?: boolean;
  onValue?: (value: ReturnType<typeof useHostProjects>) => void;
}) {
  const value = useHostProjects({ hostId, riskOnly });
  onValue?.(value);
  return null;
}

describe("useHostProjects", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("clears stale rows when switching hosts and the next load fails", async () => {
    listHostProjects
      .mockResolvedValueOnce({
        rows: [{ project_id: "project-a" }],
        next_cursor: undefined,
      })
      .mockRejectedValueOnce(new Error("closed"));

    let latest: ReturnType<typeof useHostProjects> | undefined;
    const { rerender } = render(
      <TestComponent
        hostId="host-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.rows).toEqual([{ project_id: "project-a" }]);
    expect(latest?.error).toBeNull();

    rerender(
      <TestComponent
        hostId="host-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.rows).toEqual([]);
    expect(latest?.error).toBe("closed");
    expect(listHostProjects.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ id: "host-2" }),
    );
  });

  it("ignores stale responses from the previously selected host", async () => {
    const host1 = deferred<{
      rows: Array<{ project_id: string }>;
      next_cursor?: string;
    }>();
    listHostProjects.mockReturnValueOnce(host1.promise).mockResolvedValueOnce({
      rows: [{ project_id: "project-b" }],
      next_cursor: undefined,
    });

    let latest: ReturnType<typeof useHostProjects> | undefined;
    const { rerender } = render(
      <TestComponent
        hostId="host-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    rerender(
      <TestComponent
        hostId="host-2"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.rows).toEqual([{ project_id: "project-b" }]);

    host1.resolve({
      rows: [{ project_id: "project-a" }],
      next_cursor: undefined,
    });
    await flush();

    expect(latest?.rows).toEqual([{ project_id: "project-b" }]);
    expect(listHostProjects.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: "host-1" }),
    );
    expect(listHostProjects.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: "host-2" }),
    );
  });
});
