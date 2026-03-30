import { closeDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  acquireStorageReservation,
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

  it("estimates managed rootfs reservations conservatively", () => {
    const estimated = _test.estimateManagedRootfsPullReservationBytes({
      artifact_bytes: 3 * 1024 ** 3,
      size_bytes: 9 * 1024 ** 3,
    });
    expect(estimated).toBeGreaterThan(9 * 1024 ** 3);
  });
});
