import type { StartLroState } from "@cocalc/frontend/project/start-ops";

export type ActiveStartOperation = {
  kind?: string;
  status?: string;
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
  lifecycleState,
}: {
  startLro?: StartLroState;
  activeOp?: ActiveStartOperation;
  lifecycleState?: string;
}): boolean {
  const normalizedLifecycleState = `${lifecycleState ?? ""}`
    .trim()
    .toLowerCase();

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
