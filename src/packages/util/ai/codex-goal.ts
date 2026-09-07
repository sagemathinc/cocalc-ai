// Goal snapshots are display/history data. Only explicit, unacknowledged
// commands may change the runtime goal; absence of a snapshot never clears it.
export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export interface CodexGoal {
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: number;
}
export interface CodexGoalSnapshot {
  sessionId: string;
  observedAt: number;
  goal: CodexGoal | null;
}
export interface CodexGoalCommand {
  id: string;
  // Bind edits to a known Codex session. A new thread may have no session yet.
  sessionId?: string;
  action: "set" | "clear";
  objective?: string;
  status?: "active" | "paused";
  tokenBudget?: number | null;
}
export interface CodexGoalAck {
  id: string;
  state?: "applying" | "applied" | "failed" | "cancelled";
  error?: string;
}
export interface CodexGoalEvent {
  type: "goal";
  phase: "start" | "update" | "end" | "command";
  snapshot?: CodexGoalSnapshot;
  ack?: CodexGoalAck;
}

const statuses = new Set<string>([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);

export function normalizeCodexGoal(value: any): CodexGoal | undefined {
  if (value?.toJS) value = value.toJS();
  if (
    !value ||
    typeof value.objective !== "string" ||
    !statuses.has(value.status)
  )
    return;
  return {
    objective: value.objective,
    status: value.status,
    tokenBudget:
      Number.isSafeInteger(value.tokenBudget) && value.tokenBudget > 0
        ? value.tokenBudget
        : null,
    tokensUsed:
      Number.isFinite(value.tokensUsed) && value.tokensUsed >= 0
        ? value.tokensUsed
        : 0,
    timeUsedSeconds:
      Number.isFinite(value.timeUsedSeconds) && value.timeUsedSeconds >= 0
        ? value.timeUsedSeconds
        : 0,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function normalizeCodexGoalSnapshot(
  value: any,
): CodexGoalSnapshot | undefined {
  if (value?.toJS) value = value.toJS();
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    !Number.isFinite(value.observedAt)
  )
    return;
  const goal = value.goal === null ? null : normalizeCodexGoal(value.goal);
  if (goal === undefined) return;
  return { sessionId: value.sessionId, observedAt: value.observedAt, goal };
}

export function validateCodexGoalCommand(command: CodexGoalCommand): void {
  if (
    !command ||
    typeof command.id !== "string" ||
    !command.id ||
    command.id.length > 200
  )
    throw Error("Invalid goal change identifier");
  if (command.action === "clear") return;
  if (command.action !== "set") throw Error("Invalid goal action");
  if (
    command.objective !== undefined &&
    (typeof command.objective !== "string" ||
      !command.objective.trim() ||
      command.objective.length > 100_000)
  )
    throw Error("Goal must contain between 1 and 100,000 characters");
  if (
    command.status !== undefined &&
    command.status !== "active" &&
    command.status !== "paused"
  )
    throw Error("Invalid goal status");
  if (
    command.tokenBudget !== undefined &&
    command.tokenBudget !== null &&
    (!Number.isSafeInteger(command.tokenBudget) || command.tokenBudget <= 0)
  )
    throw Error("Token budget must be a positive integer");
  if (
    command.objective === undefined &&
    command.status === undefined &&
    command.tokenBudget === undefined
  )
    throw Error("Empty goal change");
}
