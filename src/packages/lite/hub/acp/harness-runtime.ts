import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AcpAgent } from "@cocalc/ai/acp";
import type { CodexAttentionHandler } from "@cocalc/ai/acp";
import type { HarnessBinding, HarnessLauncher } from "@cocalc/ai/acp/harness";
import {
  parseAcpHarnessCredential,
  parseAcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import { createHash } from "node:crypto";

type Conversation = { path: string; threadId: string };
type Factory = (
  binding: HarnessBinding,
  conversation: Conversation,
) => ReturnType<HarnessLauncher>;
let launcher: Factory | undefined;
let authorityValidator:
  | ((binding: HarnessBinding) => Promise<void>)
  | undefined;
const discovering = new Map<
  string,
  { projectId: string; finished: Promise<void> }
>();
const discoveryPauses = new Map<string, number>();

/** Hold across draining and container removal, not just the initial sweep. */
export function pauseHarnessDiscovery(projectId: string): () => void {
  discoveryPauses.set(projectId, (discoveryPauses.get(projectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = discoveryPauses.get(projectId)! - 1;
    if (remaining) discoveryPauses.set(projectId, remaining);
    else discoveryPauses.delete(projectId);
  };
}

/** Project stop must not remove a network namespace beneath a discovery sidecar. */
export async function drainHarnessDiscovery(projectId: string): Promise<void> {
  await Promise.all(
    [...discovering.values()]
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => entry.finished),
  );
}

export function setHarnessLauncher(next?: Factory): void {
  launcher = next;
}

export function setHarnessAuthorityValidator(
  next?: (binding: HarnessBinding) => Promise<void>,
): void {
  authorityValidator = next;
}

/** A temporary session for controls only; never load or mutate a chat session. */
export async function discoverHarnessControls(request: AcpRequest) {
  if (discoveryPauses.has(request.project_id))
    throw Error("ACP discovery is unavailable while the project is stopping");
  const prepared = prepareHarnessRequest(request);
  if (!prepared.runtime) throw Error("This thread has no ACP harness");
  const key = harnessRuntimeKey(prepared);
  if (discovering.has(key) || discovering.size >= 4)
    throw Error("ACP discovery is busy; try again after it finishes");
  let finished!: () => void;
  discovering.set(key, {
    projectId: prepared.project_id,
    finished: new Promise<void>((resolve) => {
      finished = resolve;
    }),
  });
  try {
    const { AcpHarnessClient, disposeFailedHarness } =
      await import("@cocalc/ai/acp/harness");
    const factory = launcher!;
    const conversation = {
      path: prepared.chat!.path,
      threadId: prepared.chat!.thread_id!,
    };
    const client = await AcpHarnessClient.start(
      {
        projectId: prepared.project_id,
        accountId: prepared.account_id,
        profile: prepared.runtime.profile,
        credential: prepared.harness_credential!,
      },
      (binding) => factory(binding, conversation),
    );
    let controls: typeof client.controls;
    try {
      await client.open();
      await client.configure(prepared.runtime.settings ?? {});
      controls = client.controls;
    } catch (error) {
      return await disposeFailedHarness(error, () => client.dispose());
    }
    await client.dispose();
    return { profile: prepared.runtime.profile, controls };
  } finally {
    discovering.delete(key);
    finished();
  }
}

export function prepareHarnessRequest(request: AcpRequest): AcpRequest {
  if (request.runtime === undefined) {
    if (request.harness_credential !== undefined)
      throw Error("ACP credential selection requires an ACP harness");
    return request;
  }
  const runtime = parseAcpHarnessRuntime(request.runtime);
  const credential = parseAcpHarnessCredential(
    request.harness_credential,
    runtime.profile,
  );
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
    (request.chat.agent_message && !request.chat.agent_rpc_execution)
  )
    throw Error("Unsupported ACP harness request options");
  if (
    credential.mode === "account-api-key" &&
    (request.chat.agent_message || request.chat.agent_rpc_execution)
  ) {
    throw Error("Agent-authored ACP turns cannot select account credentials");
  }
  return {
    ...request,
    chat: { ...request.chat },
    runtime,
    harness_credential: credential,
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
  return JSON.stringify([
    harnessProfileKey(request),
    request.harness_credential,
  ]);
}

export function harnessProfileKey(request: AcpRequest): string {
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
  attention?: CodexAttentionHandler,
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
      credential: prepared.harness_credential!,
    },
    conversation,
    (binding) => factory(binding, conversation),
    attention,
    authorityValidator,
  );
}
