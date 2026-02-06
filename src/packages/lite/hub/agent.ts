import {
  createPlusAgentSdkBridge,
  type AgentActionEnvelope,
  type AgentActionResult,
  type AgentCapabilityManifestEntry,
} from "@cocalc/ai/agent-sdk";
import { account_id as ACCOUNT_ID } from "@cocalc/backend/data";
import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
} from "@cocalc/conat/hub/api/agent";
import { project_id as LOCAL_PROJECT_ID } from "@cocalc/project/data";
import { callRemoteHub, hasRemote, project_id as REMOTE_PROJECT_ID } from "../remote";

function getProjectId(): string {
  return REMOTE_PROJECT_ID || LOCAL_PROJECT_ID;
}

async function getCustomize(fields?: string[]) {
  if (!hasRemote) {
    return {};
  }
  return await callRemoteHub({
    name: "system.getCustomize",
    args: fields == null ? [] : [fields],
  });
}

async function ping() {
  if (!hasRemote) {
    return { now: Date.now() };
  }
  return await callRemoteHub({ name: "system.ping", args: [] });
}

function createBridge({
  defaults,
}: {
  defaults?: { projectId?: string; accountId?: string };
}) {
  const projectId = defaults?.projectId ?? getProjectId();
  return createPlusAgentSdkBridge({
    hub: {
      system: { ping, getCustomize },
      projects: {
        createProject: async () => {
          throw Error("Creating projects is not supported in lite mode");
        },
      },
    },
    project: projectApiClient({ project_id: projectId }),
    defaults: {
      accountId: ACCOUNT_ID,
      projectId,
      ...defaults,
    },
  });
}

function normalizeResult(result: AgentActionResult): AgentExecuteResponse {
  return {
    status: result.status,
    requestId: result.requestId,
    actionType: result.actionType,
    result: result.result,
    error: result.error,
    reason: result.reason,
    blockedByPolicy: result.blockedByPolicy,
    requiresConfirmation: result.requiresConfirmation,
    idempotentReplay: result.idempotentReplay,
  };
}

export async function manifest({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<AgentCapabilityManifestEntry[]> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return createBridge({}).manifest();
}

export async function execute(
  opts: AgentExecuteRequest,
): Promise<AgentExecuteResponse> {
  if (!opts.account_id) {
    throw Error("must be signed in");
  }
  const bridge = createBridge({ defaults: opts.defaults });
  const action = opts.action as AgentActionEnvelope;
  const result = await bridge.execute({
    action,
    actor: {
      ...opts.actor,
      accountId: opts.account_id,
      userId: opts.actor?.userId ?? opts.account_id,
    },
    confirmationToken: opts.confirmationToken,
  });
  return normalizeResult(result);
}
