describe("project volume quota ledger", () => {
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

  it("accepts monotonic desired state and rejects stale updates", async () => {
    const ledger = await import("./volume-quotas");
    const first = ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
    });
    expect(first.status).toBe("accepted");

    const stale = ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 5,
      desired_revision: 1,
    });
    expect(stale.status).toBe("stale");
    expect(stale.row.desired_bytes).toBe(10);
    expect(stale.row.desired_revision).toBe(2);
  });

  it("rejects conflicting values at one revision", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
    });
    expect(() =>
      ledger.acceptProjectVolumeQuotaDesired({
        project_id: "project-1",
        volume_kind: "home",
        desired_bytes: 11,
        desired_revision: 2,
      }),
    ).toThrow("conflicting home quota");
  });

  it("repairs a same-revision conflict only when explicitly authoritative", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "scratch",
      desired_bytes: 50,
      desired_revision: 2,
    });
    const repaired = ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "scratch",
      desired_bytes: 100,
      desired_revision: 2,
      repair_same_revision: true,
    });
    expect(repaired).toEqual({
      status: "accepted",
      row: expect.objectContaining({
        desired_bytes: 100,
        desired_revision: 2,
        state: "pending",
      }),
    });
  });

  it("bootstraps versioned run_quota instead of stale legacy columns", async () => {
    const projects = await import("./projects");
    const ledger = await import("./volume-quotas");
    const { getDatabase } = await import("@cocalc/lite/hub/sqlite/database");
    projects.ensureProjectsTable();
    getDatabase()
      .prepare(
        `INSERT INTO projects(
           project_id, state, disk, scratch, run_quota, run_quota_revision
         ) VALUES ('project-bootstrap', 'opened', 50, 50, ?, 2)`,
      )
      .run(JSON.stringify({ disk_quota: 0.0001 }));

    expect(ledger.bootstrapProjectVolumeQuotaLedger()).toBe(2);
    expect(ledger.getProjectVolumeQuota("project-bootstrap", "home")).toEqual(
      expect.objectContaining({ desired_bytes: 100, desired_revision: 2 }),
    );
    expect(
      ledger.getProjectVolumeQuota("project-bootstrap", "scratch"),
    ).toEqual(
      expect.objectContaining({ desired_bytes: 100, desired_revision: 2 }),
    );
  });

  it("allows legacy revision-zero desired state to advance until versioned state arrives", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
    });
    const legacyUpdate = ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 11,
    });
    expect(legacyUpdate.status).toBe("accepted");
    expect(legacyUpdate.row.desired_bytes).toBe(11);

    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 12,
      desired_revision: 1,
    });
    const staleLegacy = ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 13,
    });
    expect(staleLegacy.status).toBe("stale");
    expect(staleLegacy.row.desired_bytes).toBe(12);
  });

  it("marks only the current desired revision as applied", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
    });
    expect(
      ledger.markProjectVolumeQuotaApplied({
        project_id: "project-1",
        volume_kind: "home",
        desired_bytes: 9,
        desired_revision: 1,
        volume_identity: "volume-1",
        epoch: "filesystem-1:1",
      }),
    ).toBe(false);
    expect(
      ledger.markProjectVolumeQuotaApplied({
        project_id: "project-1",
        volume_kind: "home",
        desired_bytes: 10,
        desired_revision: 2,
        volume_identity: "volume-1",
        epoch: "filesystem-1:1",
      }),
    ).toBe(true);
    const row = ledger.getProjectVolumeQuota("project-1", "home")!;
    expect(
      ledger.projectVolumeQuotaIsApplied(row, {
        epoch: "filesystem-1:1",
      }),
    ).toBe(false);
    expect(
      ledger.projectVolumeQuotaIsApplied(row, {
        volume_identity: "volume-1",
        epoch: "filesystem-1:1",
      }),
    ).toBe(true);
  });

  it("invalidates applied state across a process or volume epoch", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
    });
    ledger.markProjectVolumeQuotaApplied({
      project_id: "project-1",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
      volume_identity: "volume-1",
      epoch: "filesystem-1:1",
    });
    const row = ledger.getProjectVolumeQuota("project-1", "home")!;
    expect(
      ledger.projectVolumeQuotaIsApplied(row, {
        volume_identity: "volume-1",
        epoch: "filesystem-1:1",
      }),
    ).toBe(true);
    expect(
      ledger.projectVolumeQuotaIsApplied(row, {
        volume_identity: "volume-2",
        epoch: "filesystem-1:1",
      }),
    ).toBe(false);
    expect(
      ledger.projectVolumeQuotaIsApplied(row, {
        volume_identity: "volume-1",
        epoch: "filesystem-1:2",
      }),
    ).toBe(false);
  });

  it("audits dirty rows immediately and stable applied rows only when due", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-audit",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
    });
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: Date.now(),
        epoch: "filesystem-1:1",
      }),
    ).toEqual([
      expect.objectContaining({
        project_id: "project-audit",
        state: "pending",
      }),
    ]);

    ledger.markProjectVolumeQuotaApplied({
      project_id: "project-audit",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 2,
      volume_identity: "volume-1",
      epoch: "filesystem-1:1",
    });
    const applied = ledger.getProjectVolumeQuota("project-audit", "home")!;
    expect(applied.next_audit_at).toBeGreaterThan(Date.now());
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: Date.now(),
        epoch: "filesystem-1:1",
      }),
    ).toEqual([]);
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: applied.next_audit_at!,
        epoch: "filesystem-1:1",
      }),
    ).toEqual([
      expect.objectContaining({
        project_id: "project-audit",
        state: "applied",
      }),
    ]);
  });

  it("counts the quotas applied in an earlier epoch", async () => {
    const ledger = await import("./volume-quotas");
    for (const project_id of ["project-old-1", "project-old-2"]) {
      ledger.acceptProjectVolumeQuotaDesired({
        project_id,
        volume_kind: "home",
        desired_bytes: 10,
        desired_revision: 1,
      });
      ledger.markProjectVolumeQuotaApplied({
        project_id,
        volume_kind: "home",
        desired_bytes: 10,
        desired_revision: 1,
        volume_identity: "volume-1",
        epoch: "filesystem-1:1",
      });
    }
    const before = ledger.countProjectVolumeQuotaEpochBacklog({
      epoch: "filesystem-1:1",
    });
    // e.g., a new quota layout
    expect(
      ledger.countProjectVolumeQuotaEpochBacklog({ epoch: "filesystem-1:2" }),
    ).toBe(before + 2);
  });

  it("delays failed-row retries but immediately detects an epoch change", async () => {
    const ledger = await import("./volume-quotas");
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-retry",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 1,
    });
    ledger.markProjectVolumeQuotaFailed({
      project_id: "project-retry",
      volume_kind: "home",
      error: "temporary failure",
    });
    const failed = ledger.getProjectVolumeQuota("project-retry", "home")!;
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: Date.now(),
        epoch: "filesystem-1:1",
      }),
    ).not.toContainEqual(
      expect.objectContaining({
        project_id: "project-stopped-scratch",
        volume_kind: "scratch",
      }),
    );
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: failed.next_audit_at!,
        epoch: "filesystem-1:1",
      }),
    ).toHaveLength(1);

    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-epoch",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 1,
    });
    ledger.markProjectVolumeQuotaApplied({
      project_id: "project-epoch",
      volume_kind: "home",
      desired_bytes: 10,
      desired_revision: 1,
      volume_identity: "volume-epoch",
      epoch: "filesystem-1:1",
    });
    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: Date.now(),
        epoch: "filesystem-1:2",
      }),
    ).toEqual([
      expect.objectContaining({
        project_id: "project-epoch",
        state: "applied",
      }),
    ]);
  });

  it("keeps stopped scratch resets out of generic quota repair until prepared", async () => {
    const projects = await import("./projects");
    const ledger = await import("./volume-quotas");
    projects.upsertProject({
      project_id: "project-stopped-scratch",
      state: "opened",
      disk: 10,
      scratch: 10,
      run_quota_revision: 1,
    });
    ledger.acceptProjectVolumeQuotaDesired({
      project_id: "project-stopped-scratch",
      volume_kind: "scratch",
      desired_bytes: 10,
      desired_revision: 1,
    });
    expect(ledger.claimStoppedScratchVolumePreparations()).toBe(1);
    expect(
      ledger.getProjectVolumeQuota("project-stopped-scratch", "scratch"),
    ).toEqual(expect.objectContaining({ reset_required: true }));
    ledger.invalidateProjectVolumeQuota({
      project_id: "project-stopped-scratch",
      volume_kind: "scratch",
      reason: "project stopped; scratch reset pending",
      reset_required: true,
    });

    expect(
      ledger.listProjectVolumeQuotaAuditBatch({
        now: Date.now(),
        epoch: "filesystem-1:1",
      }),
    ).not.toContainEqual(
      expect.objectContaining({
        project_id: "project-stopped-scratch",
        volume_kind: "scratch",
      }),
    );
    expect(ledger.listStoppedScratchVolumePreparationBatch()).toEqual([
      expect.objectContaining({
        project_id: "project-stopped-scratch",
        reset_required: true,
      }),
    ]);

    ledger.markProjectVolumeQuotaFailed({
      project_id: "project-stopped-scratch",
      volume_kind: "scratch",
      error: "temporary reset failure",
    });
    const failed = ledger.getProjectVolumeQuota(
      "project-stopped-scratch",
      "scratch",
    )!;
    expect(ledger.listStoppedScratchVolumePreparationBatch()).toEqual([]);
    expect(
      ledger.listStoppedScratchVolumePreparationBatch({
        now: failed.next_audit_at!,
      }),
    ).toHaveLength(1);

    ledger.markProjectVolumeQuotaApplied({
      project_id: "project-stopped-scratch",
      volume_kind: "scratch",
      desired_bytes: 10,
      desired_revision: 1,
      volume_identity: "scratch-volume-1",
      epoch: "filesystem-1:1",
    });
    expect(
      ledger.getProjectVolumeQuota("project-stopped-scratch", "scratch"),
    ).toEqual(expect.objectContaining({ reset_required: true }));
    expect(
      ledger.markProjectVolumeQuotaResetComplete({
        project_id: "project-stopped-scratch",
        desired_revision: 1,
      }),
    ).toBe(true);
    expect(
      ledger.getProjectVolumeQuota("project-stopped-scratch", "scratch"),
    ).toEqual(expect.objectContaining({ reset_required: false }));
    expect(
      ledger.listStoppedScratchVolumePreparationBatch({
        now: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual([]);
  });
});
