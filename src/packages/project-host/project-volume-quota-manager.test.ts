describe("project volume quota manager", () => {
  const originalSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
  });

  afterAll(() => {
    if (originalSqlite == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = originalSqlite;
    }
  });

  async function setup() {
    const filesystemState = await import("./sqlite/filesystem-quota-state");
    filesystemState.reconcileProjectFilesystemQuotaState({
      mountpoint: "/mnt/test",
      filesystem_uuid: "filesystem-1",
      quota_mode: "simple",
    });
    const ledger = await import("./sqlite/volume-quotas");
    const overrides = await import("./sqlite/volume-quota-overrides");
    const { ProjectVolumeQuotaManager } =
      await import("./project-volume-quota-manager");
    let currentSize = 100;
    let failNextApply = false;
    const applyRaw = jest.fn(async ({ size }: { size: number }) => {
      if (failNextApply) {
        failNextApply = false;
        throw new Error("apply failed");
      }
      currentSize = size;
      return { volume_identity: "volume-1" };
    });
    const adapter = {
      observe: jest.fn(async () => ({ size: currentSize, used: 80 })),
      applyRaw,
    };
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
    const manager = new ProjectVolumeQuotaManager(adapter, logger);
    return {
      ledger,
      overrides,
      manager,
      adapter,
      applyRaw,
      failNext: () => {
        failNextApply = true;
      },
      currentSize: () => currentSize,
    };
  }

  it("restores persistent desired state after a temporary claim", async () => {
    const { ledger, overrides, manager, applyRaw, currentSize } = await setup();
    const handle = await manager.beginTemporaryOverride({
      project_id: "project-1",
      kind: "snapshot_cleanup",
      minimum_bytes: 150,
    });

    expect(currentSize()).toBe(150);
    expect(
      overrides.listActiveProjectVolumeQuotaOverrides("project-1", "home"),
    ).toHaveLength(1);
    expect(ledger.getProjectVolumeQuota("project-1", "home")?.state).toBe(
      "pending",
    );

    await handle.release();
    expect(currentSize()).toBe(100);
    expect(
      overrides.listActiveProjectVolumeQuotaOverrides("project-1", "home"),
    ).toHaveLength(0);
    expect(ledger.getProjectVolumeQuota("project-1", "home")?.state).toBe(
      "applied",
    );
    expect(applyRaw.mock.calls.map(([opts]) => opts.size)).toEqual([150, 100]);
  });

  it("forwards a forced physical write for a newly recreated volume", async () => {
    const { ledger, manager, applyRaw } = await setup();
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "scratch",
      desired_bytes: 100,
    });

    await manager.applyEffectiveQuota({
      project_id: "project-1",
      volume_kind: "scratch",
      operation_class: "project_volume_prepare",
      priority: "lifecycle",
      force_write: true,
    });

    expect(applyRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        volume_kind: "scratch",
        size: 100,
        force_write: true,
      }),
    );
  });

  it("checks a quota applied incompletely again soon", async () => {
    const { ledger, manager, applyRaw } = await setup();
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 100,
    });
    // e.g., the project's quota group was not updated (file-server.ts)
    applyRaw.mockResolvedValueOnce({
      volume_identity: "volume-1",
      incomplete: "project quota group not updated",
    } as any);
    const before = Date.now();
    await manager.applyEffectiveQuota({
      project_id: "project-1",
      volume_kind: "home",
      operation_class: "scheduled_quota_audit",
      priority: "scheduled",
    });
    const row = ledger.getProjectVolumeQuota("project-1", "home")!;
    expect(row.state).toBe("pending");
    expect(row.last_error).toBe("project quota group not updated");
    expect(row.next_audit_at).toBeGreaterThanOrEqual(before + 5 * 60_000);
    // then completely
    await manager.applyEffectiveQuota({
      project_id: "project-1",
      volume_kind: "home",
      operation_class: "scheduled_quota_audit",
      priority: "scheduled",
    });
    expect(ledger.getProjectVolumeQuota("project-1", "home")?.state).toBe(
      "applied",
    );
  });

  it("fails a temporary raise that is applied incompletely", async () => {
    const { ledger, overrides, manager, applyRaw } = await setup();
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 100,
    });
    applyRaw.mockResolvedValueOnce({
      volume_identity: "volume-1",
      incomplete: "project quota group not updated",
    } as any);
    await expect(
      manager.beginTemporaryOverride({
        project_id: "project-1",
        kind: "legacy_project_archive_restore",
        minimum_bytes: 150,
      }),
    ).rejects.toThrow(
      "temporary quota override not fully applied: project quota group not updated",
    );
    // kept, to be applied again or released, like a raise that failed
    const [override] = overrides.listActiveProjectVolumeQuotaOverrides(
      "project-1",
      "home",
    );
    expect(override?.last_error).toMatch(/not fully applied/);
    expect(ledger.getProjectVolumeQuota("project-1", "home")?.state).toBe(
      "failed",
    );
  });

  it("keeps the largest overlapping claim until it is released", async () => {
    const { manager, applyRaw, currentSize } = await setup();
    const first = await manager.beginTemporaryOverride({
      project_id: "project-1",
      operation_id: "first",
      kind: "snapshot_cleanup",
      minimum_bytes: 150,
    });
    const second = await manager.beginTemporaryOverride({
      project_id: "project-1",
      operation_id: "second",
      kind: "archive_restore",
      minimum_bytes: 200,
    });
    expect(currentSize()).toBe(200);

    await second.release();
    expect(currentSize()).toBe(150);
    await first.release();
    expect(currentSize()).toBe(100);
    expect(applyRaw.mock.calls.map(([opts]) => opts.size)).toEqual([
      150, 200, 150, 100,
    ]);
  });

  it("releases orphaned claims and lowers the quota after restart", async () => {
    const { manager, overrides, currentSize } = await setup();
    await manager.beginTemporaryOverride({
      project_id: "project-1",
      kind: "snapshot_cleanup",
      minimum_bytes: 150,
    });
    expect(currentSize()).toBe(150);

    const result = await manager.recoverUnreleasedOverrides({
      reason: "restart",
    });
    expect(result).toEqual({ released: 1, errors: 0, remaining: 0 });
    expect(currentSize()).toBe(100);
    expect(
      overrides.listActiveProjectVolumeQuotaOverrides("project-1", "home"),
    ).toHaveLength(0);
  });

  it("retains a durable claim when the initial raise fails", async () => {
    const { manager, overrides, failNext, currentSize } = await setup();
    failNext();
    await expect(
      manager.beginTemporaryOverride({
        project_id: "project-1",
        kind: "snapshot_cleanup",
        minimum_bytes: 150,
      }),
    ).rejects.toThrow("apply failed");
    const [claim] = overrides.listActiveProjectVolumeQuotaOverrides(
      "project-1",
      "home",
    );
    expect(claim.last_error).toBe("Error: apply failed");

    const result = await manager.recoverUnreleasedOverrides({
      reason: "restart",
    });
    expect(result.errors).toBe(0);
    expect(currentSize()).toBe(100);
  });

  it("retries a release that failed before the persistent limit converged", async () => {
    const { manager, overrides, failNext, currentSize } = await setup();
    const handle = await manager.beginTemporaryOverride({
      project_id: "project-1",
      kind: "snapshot_cleanup",
      minimum_bytes: 150,
    });
    failNext();
    await expect(handle.release()).rejects.toThrow("apply failed");
    expect(
      overrides.getProjectVolumeQuotaOverride(handle.override.override_id)
        ?.state,
    ).toBe("release_pending");
    expect(currentSize()).toBe(150);

    const result = await manager.recoverUnreleasedOverrides({
      reason: "restart",
    });
    expect(result).toEqual({ released: 1, errors: 0, remaining: 0 });
    expect(currentSize()).toBe(100);
    expect(
      overrides.getProjectVolumeQuotaOverride(handle.override.override_id)
        ?.state,
    ).toBe("released");
  });
});
