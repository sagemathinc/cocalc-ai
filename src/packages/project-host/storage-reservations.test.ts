import * as executeCodeModule from "@cocalc/backend/execute-code";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "@cocalc/lite/hub/sqlite/database";
import {
  acquireStorageReservation,
  clearActiveStorageReservations,
  cleanupExpiredStorageReservations,
  getActiveStorageReservationSummary,
  releaseStorageReservation,
  StorageReservationError,
  _test,
} from "./storage-reservations";

describe("storage reservations", () => {
  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.COCALC_LITE_SQLITE_FILENAME;
    delete process.env.COCALC_STORAGE_ORPHANED_PULL_GRACE_MS;
  });

  it("acquires and releases reservations against conservative free space", async () => {
    const reservation = await acquireStorageReservation({
      kind: "oci-pull",
      estimated_bytes: 8 * 1024 ** 3,
      project_id: "p1",
      current_storage: {
        disk_available_conservative_bytes: 32 * 1024 ** 3,
      },
      min_free_bytes: 4 * 1024 ** 3,
    });
    expect(getActiveStorageReservationSummary().total_bytes).toBe(
      8 * 1024 ** 3,
    );
    releaseStorageReservation(reservation.reservation_id);
    expect(getActiveStorageReservationSummary().total_bytes).toBe(0);
  });

  it("blocks reservations when free space would be exhausted", async () => {
    await expect(
      acquireStorageReservation({
        kind: "rootfs-pull",
        estimated_bytes: 20 * 1024 ** 3,
        current_storage: {
          disk_available_conservative_bytes: 24 * 1024 ** 3,
        },
        min_free_bytes: 8 * 1024 ** 3,
      }),
    ).rejects.toThrow(StorageReservationError);
  });

  it("blocks reservations when metadata usage is already too high", async () => {
    await expect(
      acquireStorageReservation({
        kind: "rootfs-pull",
        estimated_bytes: 2 * 1024 ** 3,
        current_storage: {
          disk_available_conservative_bytes: 40 * 1024 ** 3,
          disk_unallocated_bytes: 4 * 1024 ** 3,
          btrfs_metadata_total_bytes: 10 * 1024 ** 3,
          btrfs_metadata_used_bytes: 9.5 * 1024 ** 3,
        },
        metadata_max_used_percent: 90,
      }),
    ).rejects.toThrow(/metadata usage/i);
  });

  it("allows high metadata usage when device unallocated headroom is still ample", async () => {
    const reservation = await acquireStorageReservation({
      kind: "rootfs-pull",
      estimated_bytes: 2 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 80 * 1024 ** 3,
        disk_unallocated_bytes: 48 * 1024 ** 3,
        btrfs_metadata_total_bytes: 10 * 1024 ** 3,
        btrfs_metadata_used_bytes: 9.5 * 1024 ** 3,
      },
      metadata_max_used_percent: 90,
    });
    expect(reservation.kind).toBe("rootfs-pull");
  });

  it("expires stale reservations from the ledger", async () => {
    const reservation = await acquireStorageReservation({
      kind: "oci-pull",
      estimated_bytes: 4 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 64 * 1024 ** 3,
      },
      ttl_ms: 1,
    });
    expect(getActiveStorageReservationSummary().count).toBe(1);
    cleanupExpiredStorageReservations(reservation.expires_at + 1);
    expect(
      getActiveStorageReservationSummary(reservation.expires_at + 1).count,
    ).toBe(0);
  });

  it("can clear all active reservations from the ledger", async () => {
    await acquireStorageReservation({
      kind: "oci-pull",
      estimated_bytes: 4 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 64 * 1024 ** 3,
      },
    });
    await acquireStorageReservation({
      kind: "rootfs-pull",
      estimated_bytes: 3 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 64 * 1024 ** 3,
      },
    });
    expect(getActiveStorageReservationSummary().count).toBe(2);
    expect(clearActiveStorageReservations()).toBe(2);
    expect(getActiveStorageReservationSummary().count).toBe(0);
  });

  it("reclaims orphaned pull reservations before denying a new admission", async () => {
    const podmanSpy = jest
      .spyOn(executeCodeModule, "executeCode")
      .mockResolvedValue({
        exit_code: 0,
        stdout: "",
        stderr: "",
      } as any);
    const oldReservation = await acquireStorageReservation({
      kind: "oci-pull",
      estimated_bytes: 20 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 30 * 1024 ** 3,
      },
      ttl_ms: 60 * 60 * 1000,
      min_free_bytes: 8 * 1024 ** 3,
    });
    getDatabase()
      .prepare(
        "UPDATE storage_reservations SET created_at = ?, expires_at = ? WHERE reservation_id = ?",
      )
      .run(
        Date.now() - 11 * 60 * 1000,
        Date.now() + 60 * 60 * 1000,
        oldReservation.reservation_id,
      );
    expect(getActiveStorageReservationSummary().count).toBe(1);
    const reservation = await acquireStorageReservation({
      kind: "rootfs-pull",
      estimated_bytes: 5 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 30 * 1024 ** 3,
      },
      min_free_bytes: 8 * 1024 ** 3,
    });
    expect(reservation.kind).toBe("rootfs-pull");
    expect(getActiveStorageReservationSummary().count).toBe(1);
    expect(podmanSpy).toHaveBeenCalled();
  });

  it("estimates managed rootfs reservations conservatively", () => {
    const estimated = _test.estimateManagedRootfsPullReservationBytes({
      artifact_bytes: 3 * 1024 ** 3,
      size_bytes: 9 * 1024 ** 3,
    });
    expect(estimated).toBeGreaterThan(9 * 1024 ** 3);
  });
});
