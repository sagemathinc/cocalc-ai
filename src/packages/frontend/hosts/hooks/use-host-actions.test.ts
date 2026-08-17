/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { SetStateAction } from "react";
import { useHostActions } from "./use-host-actions";

describe("useHostActions deletion protection", () => {
  it("uses the authoritative RPC result before refreshing the host list", async () => {
    const initial = {
      id: "host-1",
      deletion_protection: false,
    } as Host;
    const updated = {
      ...initial,
      deletion_protection: true,
    } as Host;
    let hosts = [initial];
    const setHosts = jest.fn((update: SetStateAction<Host[]>) => {
      hosts = typeof update === "function" ? update(hosts) : update;
    });
    const refresh = jest.fn().mockResolvedValue([updated]);
    const setHostDeletionProtection = jest.fn().mockResolvedValue(updated);

    const actions = useHostActions({
      hub: {
        hosts: {
          startHost: jest.fn(),
          stopHost: jest.fn(),
          deleteHost: jest.fn(),
          setHostDeletionProtection,
        },
      },
      setHosts,
      refresh,
      browser_id: "browser-1",
    });

    await actions.setHostDeletionProtection("host-1", true);

    expect(setHostDeletionProtection).toHaveBeenCalledWith({
      id: "host-1",
      browser_id: "browser-1",
      enabled: true,
    });
    expect(hosts[0].deletion_protection).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns the deprovision LRO and propagates submission failures", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const op = { op_id: "op-1" } as any;
    const deleteHost = jest
      .fn()
      .mockResolvedValueOnce(op)
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const refresh = jest.fn().mockResolvedValue([]);
    const onHostOp = jest.fn();
    const actions = useHostActions({
      hub: {
        hosts: {
          startHost: jest.fn(),
          stopHost: jest.fn(),
          deleteHost,
        },
      },
      setHosts: jest.fn(),
      refresh,
      onHostOp,
    });

    await expect(actions.removeHost("host-1")).resolves.toBe(op);
    expect(onHostOp).toHaveBeenCalledWith("host-1", op);
    await expect(
      actions.removeHost(
        "host-2",
        { skip_backups: true },
        { alertErrors: false, refreshAfter: false },
      ),
    ).rejects.toThrow("provider unavailable");
    consoleError.mockRestore();
  });
});
