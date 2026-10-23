import { createHash } from "node:crypto";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";

/** Whether an account may still use a project's agents (project-host:
 * owner or collaborator on its local project record). */
export type AcpProjectMembershipChecker = (opts: {
  account_id: string;
  project_id: string;
}) => boolean | Promise<boolean>;

let projectMembershipChecker: AcpProjectMembershipChecker | undefined;

/** Hosts with collaborators install this; single-user Lite does not. */
export function setAcpProjectMembershipChecker(
  checker: AcpProjectMembershipChecker | undefined,
): void {
  projectMembershipChecker = checker;
}

// Work can wait (queued behind a turn, held by a restart, recovered after a
// crash). Run it only if whoever sent it may still use the project now.
async function assertSenderStillProjectMember(
  request: AcpRequest,
): Promise<void> {
  if (!projectMembershipChecker) return;
  const account_id = `${request.account_id ?? ""}`.trim();
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  let member = false;
  if (account_id && project_id) {
    try {
      member = await projectMembershipChecker({ account_id, project_id });
    } catch {
      member = false;
    }
  }
  if (!member) {
    throw new Error(
      "Not run: the account that sent this message is no longer a collaborator on this project.",
    );
  }
}

/**
 * phase, for a sensor wake joining a running turn: "claim" reserves its
 * one-time permit (every check, atomically) before it is injected; then
 * "consume-claim" once it was, or "release" if it could not join (its own
 * turn consumes it then). Absent: consume, as a turn executes.
 */
export async function authorizeAgentDeliveryExecution(
  request: AcpRequest,
  api: Pick<
    AgentApi,
    | "authorizeRpcExecution"
    | "authorizeSensorExecution"
    | "authorizeRpcReportExecution"
  >,
  { phase }: { phase?: "claim" | "consume-claim" | "release" } = {},
): Promise<void> {
  const chat = request.chat;
  if (chat?.sensor_wake) {
    // The prompt CoCalc built for the wake, optionally after the queue's own
    // one-line note; the hub checks it against the wake's one-time permit.
    const content = chat.user_message_content;
    const prompt = request.prompt ?? "";
    if (
      typeof content !== "string" ||
      !(
        prompt === content ||
        (prompt.startsWith("System note: ") &&
          prompt.endsWith(content) &&
          prompt.slice(0, prompt.length - content.length).split("\n").length ===
            3)
      )
    )
      throw new Error("sensor wake prompt does not match its authorization");
    await api.authorizeSensorExecution({
      account_id: request.account_id,
      authorization: chat.sensor_wake,
      delivery: {
        prompt_sha256: createHash("sha256").update(content).digest("hex"),
        path: chat.path,
        thread_id: `${chat.thread_id ?? ""}`,
        ...(phase ? { phase } : {}),
      },
    });
    // Consumed: nothing downstream (writers, leases, logs) needs the secret.
    // Kept while the wake may still need it: claimed, or released for its
    // own turn.
    if (phase == null || phase === "consume-claim")
      chat.sensor_wake = { ...chat.sensor_wake, permit: REDACTED };
    return;
  }
  if (chat?.agent_rpc_report) {
    // A delivery report CoCalc wrote for the sender of a failed message.
    await api.authorizeRpcReportExecution({
      account_id: chat.agent_rpc_report.authorization.principal_account_id,
      report: chat.agent_rpc_report,
      delivery: { path: chat.path, thread_id: `${chat.thread_id ?? ""}` },
    });
    return;
  }
  if (chat?.agent_rpc_execution) {
    await api.authorizeRpcExecution({
      account_id: chat.agent_rpc_execution.principal_account_id,
      authorization: chat.agent_rpc_execution,
    });
    return;
  }
  if (!chat?.agent_delivery_id) {
    // An ordinary message from a person: they must still be a collaborator.
    await assertSenderStillProjectMember(request);
    return;
  }
  // Old queued work must not acquire the new RPC execution semantics, even
  // during a mixed-version rollout with a hub that still supports V1.
  throw new Error(
    "Legacy agent delivery is retired; this queued request was not executed",
  );
}

const REDACTED = "[redacted]";

/** A chat context safe to log: a sensor wake's permit is a secret. */
export function redactChatForLog<T extends AcpRequest["chat"]>(chat: T): T {
  if (!chat?.sensor_wake) return chat;
  return { ...chat, sensor_wake: { ...chat.sensor_wake, permit: REDACTED } };
}
