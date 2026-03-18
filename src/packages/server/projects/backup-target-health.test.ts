import {
  assertBackupTargetHostAvailable,
  BACKUP_TARGET_HOST_STALE_MS,
  getBackupTargetUnavailabilityReason,
  watchBackupTargetHostAvailability,
} from "./backup-target-health";

describe("backup target health", () => {
  it("explains missing or unhealthy hosts", () => {
    const now = Date.parse("2026-03-18T20:00:00.000Z");
    expect(getBackupTargetUnavailabilityReason(undefined, { now })).toBe(
      "project not found",
    );
    expect(
      getBackupTargetUnavailabilityReason(
        {
          project_id: "p1",
          host_id: null,
          host_status: null,
          host_last_seen: null,
          host_deleted: null,
        },
        { now },
      ),
    ).toBe("project has no assigned host");
    expect(
      getBackupTargetUnavailabilityReason(
        {
          project_id: "p1",
          host_id: "host-1",
          host_status: "error",
          host_last_seen: new Date(now),
          host_deleted: null,
        },
        { now },
      ),
    ).toBe("host host-1 status=error");
    expect(
      getBackupTargetUnavailabilityReason(
        {
          project_id: "p1",
          host_id: "host-1",
          host_status: "running",
          host_last_seen: new Date(now - BACKUP_TARGET_HOST_STALE_MS - 1),
          host_deleted: null,
        },
        { now },
      ),
    ).toContain("last_seen is stale");
  });

  it("accepts a healthy running host", async () => {
    await expect(
      assertBackupTargetHostAvailable({
        project_id: "p1",
        phase: "validate",
        load: async () => ({
          project_id: "p1",
          host_id: "host-1",
          host_status: "running",
          host_last_seen: new Date(),
          host_deleted: null,
        }),
      }),
    ).resolves.toMatchObject({ host_id: "host-1" });
  });

  it("rejects a watched backup once the host becomes unhealthy", async () => {
    let calls = 0;
    const watch = watchBackupTargetHostAvailability({
      project_id: "p1",
      phase: "backup",
      pollMs: 1,
      load: async () => {
        calls += 1;
        if (calls < 3) {
          return {
            project_id: "p1",
            host_id: "host-1",
            host_status: "running",
            host_last_seen: new Date(),
            host_deleted: null,
          };
        }
        return {
          project_id: "p1",
          host_id: "host-1",
          host_status: "error",
          host_last_seen: new Date(),
          host_deleted: null,
        };
      },
    });

    await expect(watch.promise).rejects.toThrow(
      "backup target unavailable during backup: host host-1 status=error",
    );
  });
});
