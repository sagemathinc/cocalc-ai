import { SNAPSHOT_HOME_RESTORE_UNAVAILABLE } from "@cocalc/conat/files/file-server";
import { assertSnapshotRestoreAllowed } from "./snapshot-restore-check";

const PROJECT = "00000000-0000-4000-8000-000000000001";

function client(checkSnapshotRestore: () => Promise<void>) {
  return { checkSnapshotRestore: jest.fn(checkSnapshotRestore) } as any;
}

describe("assertSnapshotRestoreAllowed", () => {
  it("asks the project's host", async () => {
    const c = client(async () => {});
    await assertSnapshotRestoreAllowed({
      client: c,
      project_id: PROJECT,
      mode: "home",
    });
    expect(c.checkSnapshotRestore).toHaveBeenCalledWith({
      project_id: PROJECT,
      mode: "home",
    });
  });

  it("refuses what the host refuses", async () => {
    const c = client(async () => {
      throw new Error(SNAPSHOT_HOME_RESTORE_UNAVAILABLE);
    });
    await expect(
      assertSnapshotRestoreAllowed({
        client: c,
        project_id: PROJECT,
        mode: "both",
      }),
    ).rejects.toThrow(SNAPSHOT_HOME_RESTORE_UNAVAILABLE);
  });

  it("allows it on a host from before the check", async () => {
    const c = client(async () => {
      throw new Error("unknown service method 'checkSnapshotRestore'");
    });
    await assertSnapshotRestoreAllowed({
      client: c,
      project_id: PROJECT,
      mode: "both",
    });
  });

  it("passes on other errors (the host is unreachable)", async () => {
    const c = client(async () => {
      throw new Error("timeout");
    });
    await expect(
      assertSnapshotRestoreAllowed({
        client: c,
        project_id: PROJECT,
        mode: "both",
      }),
    ).rejects.toThrow("timeout");
  });
});
