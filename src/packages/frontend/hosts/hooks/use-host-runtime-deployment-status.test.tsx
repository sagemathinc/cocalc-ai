/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHostRuntimeDeploymentStatus } from "./use-host-runtime-deployment-status";

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
  hub,
  hostId,
  enabled = true,
  onValue,
}: {
  hub: {
    hosts: {
      getHostRuntimeDeploymentStatus: jest.Mock;
    };
  };
  hostId?: string;
  enabled?: boolean;
  onValue?: (value: ReturnType<typeof useHostRuntimeDeploymentStatus>) => void;
}) {
  const value = useHostRuntimeDeploymentStatus(hub, {
    hostId,
    enabled,
    pollMs: 0,
  });
  onValue?.(value);
  return null;
}

describe("useHostRuntimeDeploymentStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale responses after the selected host is cleared", async () => {
    const request = deferred<{ phase: string }>();
    const hub = {
      hosts: {
        getHostRuntimeDeploymentStatus: jest
          .fn()
          .mockReturnValue(request.promise),
      },
    };
    let latest: ReturnType<typeof useHostRuntimeDeploymentStatus> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        hostId="host-1"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.loading).toBe(true);

    rerender(
      <TestComponent
        hub={hub}
        hostId={undefined}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.status).toBeUndefined();
    expect(latest?.loading).toBe(false);
    expect(latest?.refreshing).toBe(false);

    request.resolve({ phase: "running" });
    await flush();

    expect(latest?.status).toBeUndefined();
    expect(latest?.loading).toBe(false);
    expect(latest?.refreshing).toBe(false);
    expect(latest?.error).toBeUndefined();
  });
});
