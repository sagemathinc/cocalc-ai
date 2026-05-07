/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { useHostSoftwareVersionCatalog } from "./use-host-software-version-catalog";

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
  enabled = true,
  onValue,
}: {
  hub: {
    hosts: {
      listHostSoftwareVersions: jest.Mock;
      listHostRuntimeDeployments: jest.Mock;
    };
  };
  enabled?: boolean;
  onValue?: (value: ReturnType<typeof useHostSoftwareVersionCatalog>) => void;
}) {
  const value = useHostSoftwareVersionCatalog(hub, {
    enabled,
    hubSourceBaseUrl: "https://example.test/software",
  });
  onValue?.(value);
  return null;
}

describe("useHostSoftwareVersionCatalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clears and ignores stale results when disabled mid-request", async () => {
    const configured =
      deferred<
        Array<{ artifact: "project"; version: string; available: boolean }>
      >();
    const hubVersions =
      deferred<
        Array<{ artifact: "tools"; version: string; available: boolean }>
      >();
    const deployments = deferred<Array<{ target: string }>>();
    const hub = {
      hosts: {
        listHostSoftwareVersions: jest
          .fn()
          .mockReturnValueOnce(configured.promise)
          .mockReturnValueOnce(hubVersions.promise),
        listHostRuntimeDeployments: jest
          .fn()
          .mockReturnValue(deployments.promise),
      },
    };
    let latest: ReturnType<typeof useHostSoftwareVersionCatalog> | undefined;

    const { rerender } = render(
      <TestComponent
        hub={hub}
        enabled
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
        enabled={false}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await flush();

    expect(latest?.loading).toBe(false);
    expect(latest?.configured).toEqual([]);
    expect(latest?.hub).toEqual([]);
    expect(latest?.globalDeployments).toEqual([]);
    expect(latest?.configuredError).toBeUndefined();
    expect(latest?.hubError).toBeUndefined();
    expect(latest?.globalDeploymentsError).toBeUndefined();

    configured.resolve([
      { artifact: "project", version: "1.2.3", available: true },
    ]);
    hubVersions.resolve([
      { artifact: "tools", version: "4.5.6", available: true },
    ]);
    deployments.resolve([{ target: "project-host" }]);
    await flush();

    expect(latest?.loading).toBe(false);
    expect(latest?.configured).toEqual([]);
    expect(latest?.hub).toEqual([]);
    expect(latest?.globalDeployments).toEqual([]);
    expect(latest?.configuredError).toBeUndefined();
    expect(latest?.hubError).toBeUndefined();
    expect(latest?.globalDeploymentsError).toBeUndefined();
  });
});
