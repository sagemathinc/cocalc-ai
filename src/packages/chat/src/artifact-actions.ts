export interface ProposedAction {
  id: string;
  title: string;
  target: string;
  draft: string;
  outcome?: "executing" | "succeeded" | "failed" | "unknown";
  receipt?: string;
}
export interface ActionDecision {
  proposal: ProposedAction;
  decision: "approve" | "reject" | "undecided";
  comment: string;
}
function bounded(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > limit
  )
    throw Error("invalid proposed action text");
  return value;
}
export function validateProposedActions(value: unknown): ProposedAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw Error("action list requires 1 to 20 proposals");
  const ids = new Set<string>();
  const rows = value.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id) ||
      ids.has(row.id)
    )
      throw Error("invalid or duplicate action id");
    ids.add(row.id);
    if (
      row.outcome !== undefined &&
      !["executing", "succeeded", "failed", "unknown"].includes(row.outcome)
    )
      throw Error("invalid action outcome");
    return {
      id: row.id,
      title: bounded(row.title, 256),
      target: bounded(row.target, 1024),
      draft: bounded(row.draft, 8192),
      ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
      ...(row.receipt === undefined
        ? {}
        : { receipt: bounded(row.receipt, 2048) }),
    } as ProposedAction;
  });
  bounded(JSON.stringify(rows), 24 * 1024);
  return rows;
}
/** Execution reports are not part of the content a person approves. */
export function proposedActionBase(action: ProposedAction): string {
  return JSON.stringify([action.id, action.title, action.target, action.draft]);
}
export function validateActionDecisions(value: unknown): ActionDecision[] {
  if (!Array.isArray(value)) throw Error("invalid action decisions");
  const proposals = validateProposedActions(value.map((row) => row?.proposal));
  const result = proposals.map((proposal, index) => {
    const row = value[index];
    if (!["approve", "reject", "undecided"].includes(row.decision))
      throw Error("invalid action decision");
    return {
      proposal,
      decision: row.decision,
      comment: bounded(row.comment, 2048),
    } as ActionDecision;
  });
  bounded(JSON.stringify(result), 28 * 1024);
  return result;
}
