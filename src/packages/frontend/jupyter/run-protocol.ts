export type RunLifecycleType =
  | "run_start"
  | "run_done"
  | "cell_start"
  | "cell_done";

const RUN_LIFECYCLE_TYPES = new Set<RunLifecycleType>([
  "run_start",
  "run_done",
  "cell_start",
  "cell_done",
]);

export interface RunStreamMessage {
  id?: string;
  run_id?: string;
  lifecycle?: string;
  msg_type?: string;
}

export function getRunLifecycleType(
  message: RunStreamMessage | null | undefined,
): RunLifecycleType | null {
  const lifecycle = message?.lifecycle;
  if (
    typeof lifecycle === "string" &&
    RUN_LIFECYCLE_TYPES.has(lifecycle as RunLifecycleType)
  ) {
    return lifecycle as RunLifecycleType;
  }
  const msgType = message?.msg_type;
  if (
    typeof msgType === "string" &&
    RUN_LIFECYCLE_TYPES.has(msgType as RunLifecycleType)
  ) {
    return msgType as RunLifecycleType;
  }
  return null;
}

export type RunMessageDecision =
  | { kind: "drop_stale_run_id"; mesgRunId: string }
  | { kind: "drop_missing_id"; source: "lifecycle" | "data" }
  | { kind: "drop_after_finalize"; id: string }
  | { kind: "lifecycle"; lifecycle: RunLifecycleType; id?: string }
  | { kind: "data"; id: string };

export function classifyRunStreamMessage({
  message,
  activeRunId,
  finalizedCells,
}: {
  message: RunStreamMessage | null | undefined;
  activeRunId: string;
  finalizedCells: Set<string>;
}): RunMessageDecision {
  const mesgRunId = message?.run_id;
  if (typeof mesgRunId === "string" && mesgRunId !== activeRunId) {
    return { kind: "drop_stale_run_id", mesgRunId };
  }

  const lifecycle = getRunLifecycleType(message);
  if (lifecycle != null) {
    if (lifecycle === "run_start" || lifecycle === "run_done") {
      return { kind: "lifecycle", lifecycle };
    }
    const id = message?.id;
    if (typeof id !== "string" || id.length === 0) {
      return { kind: "drop_missing_id", source: "lifecycle" };
    }
    return { kind: "lifecycle", lifecycle, id };
  }

  const id = message?.id;
  if (typeof id !== "string" || id.length === 0) {
    return { kind: "drop_missing_id", source: "data" };
  }
  if (finalizedCells.has(id)) {
    return { kind: "drop_after_finalize", id };
  }
  return { kind: "data", id };
}

