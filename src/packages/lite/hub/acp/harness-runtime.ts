import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AcpAgent } from "@cocalc/ai/acp";
import type { HarnessBinding, HarnessLauncher } from "@cocalc/ai/acp/harness";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
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
  const runtime = request.runtime;
  if (
    !runtime ||
    runtime.version !== 1 ||
    runtime.kind !== "acp" ||
    Object.keys(runtime).some(
      (key) => !["version", "kind", "profile"].includes(key),
    )
  )
    throw Error("Unsupported agent runtime");
  const profile = parseAcpHarnessProfile(runtime.profile);
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
    request.chat.agent_rpc_execution ||
    request.chat.agent_message
  )
    throw Error("Unsupported ACP harness request options");
  return {
    ...request,
    chat: { ...request.chat },
    runtime: { version: 1, kind: "acp", profile },
  };
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
