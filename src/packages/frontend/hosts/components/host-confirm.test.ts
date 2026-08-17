import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  bulkHostDeprovisionConfirmPhrase,
  runBulkHostDeprovision,
  resolveHostDeprovisionOptions,
} from "./host-confirm";

describe("host bulk deprovision helpers", () => {
  it("requires a typed confirmation phrase based on host count", () => {
    expect(bulkHostDeprovisionConfirmPhrase(3)).toBe("deprovision 3");
  });

  it("forces skip_backups for hosts that are not running", () => {
    const host = {
      id: "host-off",
      name: "Host Off",
      status: "off",
    } as Host;

    expect(resolveHostDeprovisionOptions(host, false)).toEqual({
      skip_backups: true,
    });
    expect(resolveHostDeprovisionOptions(host, true)).toEqual({
      skip_backups: true,
    });
  });

  it("uses the selected skip_backups policy for running hosts", () => {
    const host = {
      id: "host-running",
      name: "Host Running",
      status: "running",
    } as Host;

    expect(resolveHostDeprovisionOptions(host, false)).toEqual({
      skip_backups: false,
    });
    expect(resolveHostDeprovisionOptions(host, true)).toEqual({
      skip_backups: true,
    });
  });

  it("deprovisions up to 20 hosts at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hosts = Array.from({ length: 21 }, (_, i) => ({
      id: `host-${i + 1}`,
      name: `Host ${i + 1}`,
      status: "running",
    })) as Host[];

    const onConfirm = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await runBulkHostDeprovision({
      hosts,
      skipRunningBackups: false,
      onConfirm,
    });

    expect(onConfirm).toHaveBeenCalledTimes(21);
    expect(maxInFlight).toBe(20);
  });

  it("returns operation ids and preserves ordinary per-host failures", async () => {
    const hosts = [
      { id: "host-ok", name: "Host OK", status: "off" },
      { id: "host-failed", name: "Host Failed", status: "off" },
    ] as Host[];

    const results = await runBulkHostDeprovision({
      hosts,
      skipRunningBackups: false,
      onConfirm: async (host) => {
        if (host.id === "host-failed") {
          throw new Error("provider rejected request");
        }
        return { op_id: "op-123" } as any;
      },
    });

    expect(results).toEqual([
      {
        host: hosts[0],
        status: "submitted",
        op_id: "op-123",
      },
      {
        host: hosts[1],
        status: "failed",
        error: "provider rejected request",
      },
    ]);
  });

  it("propagates fresh-auth failures so the whole batch can be retried", async () => {
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";

    await expect(
      runBulkHostDeprovision({
        hosts: [{ id: "host-1", status: "off" } as Host],
        skipRunningBackups: false,
        onConfirm: async () => {
          throw freshAuthError;
        },
      }),
    ).rejects.toBe(freshAuthError);
  });
});
