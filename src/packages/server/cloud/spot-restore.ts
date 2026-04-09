export type SpotRestoreHostLike = {
  id?: string;
  status?: string;
  metadata?: Record<string, any>;
};

const INTENTIONAL_PENDING_ACTIONS = new Set([
  "stop",
  "restart",
  "hard_restart",
  "delete",
  "deprovision",
  "force_deprovision",
  "remove_connector",
  "upgrade_software",
  "reconcile_software",
]);

const INTENTIONAL_SUCCESS_ACTIONS = new Set([
  "stop",
  "delete",
  "deprovision",
  "force_deprovision",
  "remove_connector",
]);

function pricingModel(row: SpotRestoreHostLike): "on_demand" | "spot" {
  return row.metadata?.pricing_model === "spot" ? "spot" : "on_demand";
}

function interruptionRestorePolicy(
  row: SpotRestoreHostLike,
): "none" | "immediate" {
  const explicit = row.metadata?.interruption_restore_policy;
  if (explicit === "none") return "none";
  if (explicit === "immediate") return "immediate";
  return pricingModel(row) === "spot" ? "immediate" : "none";
}

export function desiredHostState(
  row: SpotRestoreHostLike,
): "running" | "stopped" {
  const explicit = `${row.metadata?.desired_state ?? ""}`.trim().toLowerCase();
  if (explicit === "running" || explicit === "stopped") {
    return explicit;
  }
  const status = `${row.status ?? ""}`.trim().toLowerCase();
  return ["running", "active", "starting", "restarting"].includes(status)
    ? "running"
    : "stopped";
}

export function shouldAutoRestoreInterruptedSpotHost(
  row: SpotRestoreHostLike,
): boolean {
  if (pricingModel(row) !== "spot") return false;
  if (interruptionRestorePolicy(row) !== "immediate") return false;
  if (`${row.status ?? ""}`.trim().toLowerCase() === "deprovisioned") {
    return false;
  }
  if (desiredHostState(row) !== "running") return false;
  const lastAction = `${row.metadata?.last_action ?? ""}`.trim().toLowerCase();
  const lastActionStatus = `${row.metadata?.last_action_status ?? ""}`
    .trim()
    .toLowerCase();
  if (
    lastActionStatus === "pending" &&
    INTENTIONAL_PENDING_ACTIONS.has(lastAction)
  ) {
    return false;
  }
  if (
    lastActionStatus === "success" &&
    INTENTIONAL_SUCCESS_ACTIONS.has(lastAction)
  ) {
    return false;
  }
  return true;
}
