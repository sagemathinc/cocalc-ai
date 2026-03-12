import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  bulkHostDeprovisionConfirmPhrase,
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
});
