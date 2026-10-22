/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import {
  acceptProjectVolumeQuotaDesired,
  getProjectVolumeQuota,
  invalidateProjectVolumeQuota,
  markProjectVolumeQuotaApplied,
  markProjectVolumeQuotaApplying,
  markProjectVolumeQuotaFailed,
  type ProjectVolumeKind,
} from "./sqlite/volume-quotas";
import {
  completeProjectVolumeQuotaOverrideRelease,
  createProjectVolumeQuotaOverride,
  effectiveProjectVolumeQuotaBytes,
  getProjectVolumeQuotaOverride,
  listUnreleasedProjectVolumeQuotaOverrides,
  markProjectVolumeQuotaOverrideApplied,
  markProjectVolumeQuotaOverrideFailed,
  releaseProjectVolumeQuotaOverride,
  type ProjectVolumeQuotaOverrideRow,
} from "./sqlite/volume-quota-overrides";

export interface ProjectVolumeQuotaAdapter {
  observe: (
    project_id: string,
    volume_kind: ProjectVolumeKind,
  ) => Promise<{ size: number; used: number }>;
  applyRaw: (opts: {
    project_id: string;
    volume_kind: ProjectVolumeKind;
    size: number;
    force_write?: boolean;
    operation_id?: string;
    operation_class: string;
    priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
  }) => Promise<{
    volume_identity: string;
    // the limit is set, but not all of the quota (why): checked again soon
    incomplete?: string;
  }>;
}

// When a quota applied incompletely is checked again.
const INCOMPLETE_RETRY_MS = 5 * 60_000;

export interface ProjectVolumeQuotaManagerLogger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface ProjectVolumeQuotaOverrideHandle {
  override: ProjectVolumeQuotaOverrideRow;
  release: () => Promise<void>;
}

const transitionTails = new Map<string, Promise<void>>();

async function withQuotaTransitionLock<T>(
  project_id: string,
  volume_kind: ProjectVolumeKind,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${project_id}:${volume_kind}`;
  const previous = transitionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  transitionTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (transitionTails.get(key) === tail) {
      transitionTails.delete(key);
    }
  }
}

export class ProjectVolumeQuotaManager {
  constructor(
    private readonly adapter: ProjectVolumeQuotaAdapter,
    private readonly logger: ProjectVolumeQuotaManagerLogger,
  ) {}

  private async ensurePersistentDesired(
    project_id: string,
    volume_kind: ProjectVolumeKind,
  ) {
    const existing = getProjectVolumeQuota(project_id, volume_kind);
    if (existing) return existing;
    const observed = await this.adapter.observe(project_id, volume_kind);
    if (!Number.isFinite(observed.size) || observed.size <= 0) {
      throw new Error(
        `managed ${volume_kind} volume for project ${project_id} has no finite persistent quota`,
      );
    }
    return acceptProjectVolumeQuotaDesired({
      project_id,
      volume_kind,
      desired_bytes: observed.size,
    }).row;
  }

  private async applyEffectiveUnlocked({
    project_id,
    volume_kind,
    operation_id,
    operation_class,
    priority,
    force_write,
  }: {
    project_id: string;
    volume_kind: ProjectVolumeKind;
    operation_id?: string;
    operation_class: string;
    priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
    force_write?: boolean;
  }): Promise<number> {
    const persistent = await this.ensurePersistentDesired(
      project_id,
      volume_kind,
    );
    const { effective_bytes, overrides } = effectiveProjectVolumeQuotaBytes({
      project_id,
      volume_kind,
      persistent_bytes: persistent.desired_bytes,
    });
    markProjectVolumeQuotaApplying({ project_id, volume_kind });
    try {
      const { volume_identity, incomplete } = await this.adapter.applyRaw({
        project_id,
        volume_kind,
        size: effective_bytes,
        force_write,
        operation_id,
        operation_class,
        priority,
      });
      if (incomplete && overrides.length) {
        // A temporary raise (e.g., for a restore) is only useful whole: with
        // the project's quota group still at its old limit, what it is for
        // would run out of room midway.  Fails like a limit not set.
        throw new Error(
          `temporary quota override not fully applied: ${incomplete}`,
        );
      }
      if (overrides.length) {
        for (const { override_id } of overrides) {
          markProjectVolumeQuotaOverrideApplied(override_id);
        }
        invalidateProjectVolumeQuota({
          project_id,
          volume_kind,
          reason: `temporary quota override active at ${effective_bytes} bytes`,
          retry_at: Math.min(
            ...overrides.map(({ expires_at }) =>
              expires_at == null ? Date.now() + 5 * 60_000 : expires_at,
            ),
          ),
        });
      } else if (incomplete) {
        invalidateProjectVolumeQuota({
          project_id,
          volume_kind,
          reason: incomplete,
          retry_at: Date.now() + INCOMPLETE_RETRY_MS,
        });
      } else {
        markProjectVolumeQuotaApplied({
          project_id,
          volume_kind,
          desired_bytes: persistent.desired_bytes,
          desired_revision: persistent.desired_revision,
          volume_identity,
        });
      }
      return effective_bytes;
    } catch (err) {
      for (const { override_id } of overrides) {
        markProjectVolumeQuotaOverrideFailed(override_id, err);
      }
      markProjectVolumeQuotaFailed({
        project_id,
        volume_kind,
        error: err,
      });
      throw err;
    }
  }

  async applyEffectiveQuota({
    project_id,
    volume_kind,
    operation_id,
    operation_class,
    priority,
    force_write,
  }: {
    project_id: string;
    volume_kind: ProjectVolumeKind;
    operation_id?: string;
    operation_class: string;
    priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
    force_write?: boolean;
  }): Promise<number> {
    return await withQuotaTransitionLock(
      project_id,
      volume_kind,
      async () =>
        await this.applyEffectiveUnlocked({
          project_id,
          volume_kind,
          operation_id,
          operation_class,
          priority,
          force_write,
        }),
    );
  }

  async beginTemporaryOverride({
    project_id,
    volume_kind = "home",
    operation_id = randomUUID(),
    kind,
    minimum_bytes,
    expires_at,
    operation_class = "interactive",
    priority = "interactive",
  }: {
    project_id: string;
    volume_kind?: ProjectVolumeKind;
    operation_id?: string;
    kind: string;
    minimum_bytes: number;
    expires_at?: number;
    operation_class?: string;
    priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
  }): Promise<ProjectVolumeQuotaOverrideHandle> {
    const override = await withQuotaTransitionLock(
      project_id,
      volume_kind,
      async () => {
        await this.ensurePersistentDesired(project_id, volume_kind);
        const row = createProjectVolumeQuotaOverride({
          project_id,
          volume_kind,
          operation_id,
          kind,
          minimum_bytes,
          expires_at,
        });
        invalidateProjectVolumeQuota({
          project_id,
          volume_kind,
          reason: `temporary quota override ${row.override_id} created`,
        });
        await this.applyEffectiveUnlocked({
          project_id,
          volume_kind,
          operation_id,
          operation_class,
          priority,
        });
        this.logger.info("temporary project volume quota override applied", {
          override_id: row.override_id,
          project_id,
          volume_kind,
          operation_id,
          kind,
          minimum_bytes: row.minimum_bytes,
          expires_at: row.expires_at,
        });
        return row;
      },
    );
    let released = false;
    return {
      override,
      release: async () => {
        if (released) return;
        await this.releaseTemporaryOverride(override.override_id, {
          operation_class,
          priority,
        });
        released = true;
      },
    };
  }

  async releaseTemporaryOverride(
    override_id: string,
    {
      operation_class = "interactive",
      priority = "interactive",
    }: {
      operation_class?: string;
      priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
    } = {},
  ): Promise<void> {
    const current = getProjectVolumeQuotaOverride(override_id);
    if (!current || current.state === "released") return;
    await withQuotaTransitionLock(
      current.project_id,
      current.volume_kind,
      async () => {
        const released = releaseProjectVolumeQuotaOverride(override_id);
        if (!released || released.state !== "release_pending") return;
        invalidateProjectVolumeQuota({
          project_id: released.project_id,
          volume_kind: released.volume_kind,
          reason: `temporary quota override ${override_id} released`,
        });
        try {
          await this.applyEffectiveUnlocked({
            project_id: released.project_id,
            volume_kind: released.volume_kind,
            operation_id: released.operation_id,
            operation_class,
            priority,
          });
          completeProjectVolumeQuotaOverrideRelease(override_id);
        } catch (err) {
          markProjectVolumeQuotaOverrideFailed(override_id, err);
          throw err;
        }
        this.logger.info("temporary project volume quota override released", {
          override_id,
          project_id: released.project_id,
          volume_kind: released.volume_kind,
          operation_id: released.operation_id,
          kind: released.kind,
        });
      },
    );
  }

  async withTemporaryOverride<T>(
    opts: Parameters<ProjectVolumeQuotaManager["beginTemporaryOverride"]>[0],
    run: () => Promise<T>,
  ): Promise<T> {
    const handle = await this.beginTemporaryOverride(opts);
    let result: T;
    let actionError: unknown;
    try {
      result = await run();
    } catch (err) {
      actionError = err;
    }
    try {
      await handle.release();
    } catch (releaseError) {
      this.logger.warn("temporary quota override release failed", {
        override_id: handle.override.override_id,
        project_id: handle.override.project_id,
        volume_kind: handle.override.volume_kind,
        releaseError: `${releaseError}`,
      });
      if (actionError == null) {
        throw releaseError;
      }
    }
    if (actionError != null) {
      throw actionError;
    }
    return result!;
  }

  async recoverUnreleasedOverrides({
    expired_before,
    reason,
    limit = 256,
  }: {
    expired_before?: number;
    reason: "restart" | "expired";
    limit?: number;
  }): Promise<{ released: number; errors: number; remaining: number }> {
    const rows = listUnreleasedProjectVolumeQuotaOverrides({
      expired_before,
      limit,
    });
    let released = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        await this.releaseTemporaryOverride(row.override_id, {
          operation_class: "quota_override_scavenger",
          priority: "scavenger",
        });
        released += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn("failed to recover temporary quota override", {
          reason,
          override_id: row.override_id,
          project_id: row.project_id,
          volume_kind: row.volume_kind,
          err: `${err}`,
        });
      }
    }
    return {
      released,
      errors,
      remaining: listUnreleasedProjectVolumeQuotaOverrides({
        expired_before,
        limit: 1,
      }).length,
    };
  }
}
