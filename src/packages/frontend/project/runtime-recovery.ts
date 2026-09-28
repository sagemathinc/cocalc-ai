/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_RUNTIME_RECOVERY_EVENT = "runtime-recovery";

const foregroundViews = new Map<string, Set<object>>();

export function registerForegroundProjectRuntimeView(
  projectId: string,
): () => void {
  const token = {};
  const views = foregroundViews.get(projectId) ?? new Set<object>();
  views.add(token);
  foregroundViews.set(projectId, views);
  return () => {
    views.delete(token);
    if (views.size === 0 && foregroundViews.get(projectId) === views) {
      foregroundViews.delete(projectId);
    }
  };
}

export function hasForegroundProjectRuntimeView(projectId: string): boolean {
  return (foregroundViews.get(projectId)?.size ?? 0) > 0;
}

export interface RuntimeRecoveryNotice {
  id: string;
  reason: "project_runtime_changed" | "project_runtime_lost";
  occurred_at: number;
  runtime_exit_reason?: string;
}

export function shouldDisplayRuntimeRecoveryNotice(
  notice: RuntimeRecoveryNotice,
): boolean {
  return notice.reason === "project_runtime_lost";
}

export function shouldShowProjectRuntimeRecoveryBanner({
  notice,
  runtimePreparing,
}: {
  notice?: RuntimeRecoveryNotice;
  runtimePreparing: boolean;
}): boolean {
  // Startup progress is the more accurate explanation while a start operation
  // is active. A delayed runtime-loss notice must not turn image preparation
  // into a misleading "reconnecting tools" warning.
  return (
    !runtimePreparing &&
    notice != null &&
    shouldDisplayRuntimeRecoveryNotice(notice)
  );
}

export function shouldDismissRuntimeRecoveryNotice({
  projectState,
  notice,
}: {
  projectState?: string;
  notice?: unknown;
}): boolean {
  // A running projection is the control-plane acknowledgement that the
  // automatic restart completed; keep the notice visible for all other states.
  return projectState === "running" && notice != null;
}

export function projectRuntimeExitReason(project: unknown): string | undefined {
  const state = (project as any)?.get?.("state") ?? (project as any)?.state;
  const reason =
    state?.get?.("runtime_exit_reason") ?? state?.runtime_exit_reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

export function shouldRecoverFromProjectRuntimeExit(project: unknown): boolean {
  const reason = projectRuntimeExitReason(project);
  return (
    reason === "container_missing" ||
    reason === "host_pressure" ||
    reason === "host_pressure_free"
  );
}

export function shouldAutoRestartAfterRuntimeLoss({
  runtimeExitReason,
  projectVisible,
  browserVisible,
}: {
  runtimeExitReason?: string;
  projectVisible: boolean;
  browserVisible: boolean;
}): boolean {
  // Retained background projects must not undo intentional pressure eviction.
  // Opening/starting a project explicitly uses the normal start path instead.
  if (
    runtimeExitReason === "host_pressure" ||
    runtimeExitReason === "host_pressure_free"
  ) {
    return projectVisible && browserVisible;
  }
  return true;
}

export function isFreeTierPressureRecovery(
  notice: RuntimeRecoveryNotice | undefined,
): boolean {
  return notice?.runtime_exit_reason === "host_pressure_free";
}

export function projectRuntimeExitKey(project: unknown): string | undefined {
  const reason = projectRuntimeExitReason(project);
  if (reason == null) {
    return undefined;
  }
  const state = (project as any)?.get?.("state") ?? (project as any)?.state;
  const time = state?.get?.("time") ?? state?.time ?? "";
  return `${reason}:${time}`;
}

export class ProjectRuntimeExitTracker {
  private exitKey?: string;

  observe(project: unknown): string | undefined {
    if (!shouldRecoverFromProjectRuntimeExit(project)) {
      return undefined;
    }
    const nextExitKey = projectRuntimeExitKey(project);
    if (nextExitKey == null || nextExitKey === this.exitKey) {
      return undefined;
    }
    this.exitKey = nextExitKey;
    return projectRuntimeExitReason(project);
  }
}

export function projectRuntimeId(status: unknown): string | undefined {
  if (status == null || typeof status !== "object") {
    return undefined;
  }
  const runtimeId = (status as { runtime_id?: unknown }).runtime_id;
  return typeof runtimeId === "string" && runtimeId.length > 0
    ? runtimeId
    : undefined;
}

export class ProjectRuntimeTracker {
  private runtimeId?: string;

  observe(status: unknown): string | undefined {
    const nextRuntimeId = projectRuntimeId(status);
    if (nextRuntimeId == null) {
      return undefined;
    }
    const changed =
      this.runtimeId != null && this.runtimeId !== nextRuntimeId
        ? nextRuntimeId
        : undefined;
    this.runtimeId = nextRuntimeId;
    return changed;
  }

  reset(): void {
    this.runtimeId = undefined;
  }
}
