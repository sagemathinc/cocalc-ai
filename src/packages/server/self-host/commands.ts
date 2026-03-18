import getPool from "@cocalc/database/pool";

const DEFAULT_POLL_MS = 2000;

function pool() {
  return getPool();
}

async function sleep(ms: number) {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

type SelfHostCommandRow = {
  action: string;
  state: string;
  result: any;
  error: string | null;
};

type SelfHostCommandOutcome =
  | { kind: "success"; result: any }
  | { kind: "promote-delete"; result: any }
  | { kind: "error"; error: string }
  | { kind: "wait" };

export function resolveSelfHostCommandOutcome(
  row: SelfHostCommandRow,
): SelfHostCommandOutcome {
  if (row.state === "done") {
    return { kind: "success", result: row.result ?? {} };
  }
  if (row.state === "error") {
    return {
      kind: "error",
      error: row.error ?? "self-host command failed",
    };
  }
  // Delete is destructive and can terminate the connector before it posts the
  // final ack. Once the connector has fetched the command, treat it as
  // accepted so host deprovision doesn't falsely fail on a timeout.
  if (row.action === "delete" && row.state === "sent") {
    return {
      kind: "promote-delete",
      result: row.result ?? { accepted: true, action: "delete" },
    };
  }
  return { kind: "wait" };
}

export async function enqueueSelfHostCommand(opts: {
  connector_id: string;
  action:
    | "create"
    | "start"
    | "stop"
    | "delete"
    | "status"
    | "resize"
    | "restart"
    | "hard_restart";
  payload: Record<string, any>;
}): Promise<string> {
  const { rows: connectors } = await pool().query(
    `SELECT connector_id
       FROM self_host_connectors
      WHERE connector_id=$1 AND revoked IS NOT TRUE`,
    [opts.connector_id],
  );
  if (!connectors[0]) {
    throw new Error("self-host connector not found");
  }
  const { rows } = await pool().query(
    `INSERT INTO self_host_commands
       (command_id, connector_id, action, payload, state, created, updated)
     VALUES (gen_random_uuid(), $1, $2, $3, 'pending', NOW(), NOW())
     RETURNING command_id`,
    [opts.connector_id, opts.action, opts.payload],
  );
  const commandId = rows[0]?.command_id;
  if (!commandId) {
    throw new Error("failed to enqueue self-host command");
  }
  return commandId;
}

export async function waitForSelfHostCommand(
  commandId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool().query<SelfHostCommandRow>(
      `SELECT action, state, result, error
       FROM self_host_commands
       WHERE command_id=$1`,
      [commandId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("self-host command not found");
    }
    const outcome = resolveSelfHostCommandOutcome(row);
    if (outcome.kind === "success") {
      return outcome.result;
    }
    if (outcome.kind === "error") {
      throw new Error(outcome.error);
    }
    if (outcome.kind === "promote-delete") {
      await pool().query(
        `UPDATE self_host_commands
         SET state='done',
             result=COALESCE(result, $2::jsonb),
             error=NULL,
             updated=NOW()
         WHERE command_id=$1 AND state='sent'`,
        [commandId, outcome.result],
      );
      return outcome.result;
    }
    await sleep(pollMs);
  }
  throw new Error("self-host command timed out");
}

export async function sendSelfHostCommand(opts: {
  connector_id: string;
  action:
    | "create"
    | "start"
    | "stop"
    | "delete"
    | "status"
    | "resize"
    | "restart"
    | "hard_restart";
  payload: Record<string, any>;
  timeoutMs?: number;
}): Promise<any> {
  const commandId = await enqueueSelfHostCommand({
    connector_id: opts.connector_id,
    action: opts.action,
    payload: opts.payload,
  });
  return await waitForSelfHostCommand(commandId, { timeoutMs: opts.timeoutMs });
}
