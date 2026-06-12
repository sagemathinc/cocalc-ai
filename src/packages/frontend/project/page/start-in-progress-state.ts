import type { StartLroState } from "@cocalc/frontend/project/start-ops";

export type ActiveStartOperation = {
  kind?: string;
  status?: string;
} | null;

export type RestartRequest = {
  token?: string;
  requested_at?: string;
} | null;

export function isStartActive(startLro?: StartLroState): boolean {
  return (
    startLro != null &&
    (!startLro.summary ||
      startLro.summary.status === "queued" ||
      startLro.summary.status === "running")
  );
}

export function isActiveOpStartLike(activeOp?: ActiveStartOperation): boolean {
  return (
    activeOp?.kind === "project-start" &&
    (activeOp.status === "queued" || activeOp.status === "running")
  );
}

export function isStartInProgressActive({
  startLro,
  activeOp,
  restartRequest,
  lifecycleState,
}: {
  startLro?: StartLroState;
  activeOp?: ActiveStartOperation;
  restartRequest?: RestartRequest;
  lifecycleState?: string;
}): boolean {
  const normalizedLifecycleState = `${lifecycleState ?? ""}`
    .trim()
    .toLowerCase();

  if (restartRequest?.token) {
    return true;
  }

  if (normalizedLifecycleState === "running") {
    return false;
  }

  return (
    isStartActive(startLro) ||
    isActiveOpStartLike(activeOp) ||
    normalizedLifecycleState === "starting" ||
    normalizedLifecycleState === "opening"
  );
}
