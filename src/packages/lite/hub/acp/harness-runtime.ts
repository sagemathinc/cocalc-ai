import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AcpAgent } from "@cocalc/ai/acp";
import type { HarnessBinding, HarnessLauncher } from "@cocalc/ai/acp/harness";
import { parseAcpHarnessRuntime } from "@cocalc/util/ai/runtime";
import { createHash } from "node:crypto";

type Conversation = { path: string; threadId: string };
type Factory = (
  binding: HarnessBinding,
  conversation: Conversation,
) => ReturnType<HarnessLauncher>;
let launcher: Factory | undefined;

export function setHarnessLauncher(next?: Factory): void {
  launcher = next;
}

export function prepareHarnessRequest(request: AcpRequest): AcpRequest {
  if (request.runtime === undefined) return request;
  const runtime = parseAcpHarnessRuntime(request.runtime);
  if (!launcher || process.env.COCALC_ACP_HARNESSES !== "1")
    throw Error("ACP harness execution is not enabled on this host");
  if (
    !request.chat?.path ||
    !request.chat.thread_id ||
    request.chat.project_id !== request.project_id
  )
    throw Error("ACP harness requires a project-bound conversation");
  if (
    (request.config && Object.keys(request.config).length) ||
    (request.runtime_env && Object.keys(request.runtime_env).length) ||
    request.recovery_parent_op_id ||
    request.chat.recovery_parent_op_id ||
    request.chat.automation_id ||
    request.chat.send_mode === "immediate" ||
    request.chat.agent_rpc_execution?.guidance ||
    (request.chat.agent_message && !request.chat.agent_rpc_execution)
  )
    throw Error("Unsupported ACP harness request options");
  return {
    ...request,
    chat: { ...request.chat },
    runtime,
  };
}

/** Refresh native context after a queue wait without replacing admitted choices. */
export function queuedAgentSession(
  admitted: AcpRequest,
  current: AcpRequest,
): Pick<AcpRequest, "config" | "session_id"> {
  if (admitted.runtime || current.runtime) {
    if (
      !admitted.runtime ||
      !current.runtime ||
      JSON.stringify(parseAcpHarnessRuntime(admitted.runtime).profile) !==
        JSON.stringify(parseAcpHarnessRuntime(current.runtime).profile)
    )
      throw Error("Recipient ACP runtime changed while the message was queued");
    return {
      config: undefined,
      session_id: admitted.session_id ?? current.session_id,
    };
  }
  return { config: current.config, session_id: current.session_id };
}

// Validate shared configuration, but never let it replace an explicitly
// submitted selection. Queued execution uses the admitted snapshot instead.
export function assertConfiguredHarnessRuntime(
  request: Pick<AcpRequest, "runtime">,
  configured: unknown,
): void {
  if (configured == null) return;
  const expected = parseAcpHarnessRuntime(configured);
  if (
    !request.runtime ||
    JSON.stringify(parseAcpHarnessRuntime(request.runtime)) !==
      JSON.stringify(expected)
  )
    throw Error(
      "This thread uses an ACP harness; reload its runtime settings before sending",
    );
}

export function harnessRuntimeKey(request: AcpRequest): string {
  if (!request.runtime || !request.chat)
    throw Error("Missing ACP runtime binding");
  return JSON.stringify([
    "acp",
    request.project_id,
    request.account_id,
    request.chat.path,
    request.chat.thread_id,
    createHash("sha256")
      .update(JSON.stringify(request.runtime.profile))
      .digest("hex"),
  ]);
}

export async function createHarnessAgent(
  request: AcpRequest,
): Promise<AcpAgent> {
  const prepared = prepareHarnessRequest(request);
  const { HarnessAgent } = await import("@cocalc/ai/acp/harness");
  const conversation = {
    path: prepared.chat!.path,
    threadId: prepared.chat!.thread_id!,
  };
  const factory = launcher!;
  return new HarnessAgent(
    {
      projectId: prepared.project_id,
      accountId: prepared.account_id,
      profile: prepared.runtime!.profile,
    },
    conversation,
    (binding) => factory(binding, conversation),
  );
}
