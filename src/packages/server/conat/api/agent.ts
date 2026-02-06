import {
  createLaunchpadAgentSdkBridge,
  type AgentActionEnvelope,
  type AgentCapabilityManifestEntry,
  type AgentActionResult,
} from "@cocalc/ai/agent-sdk";
import { projectApiClient } from "@cocalc/conat/project/api";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";
import { conat } from "@cocalc/backend/conat";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
} from "@cocalc/conat/hub/api/agent";
import * as projects from "./projects";
import * as system from "./system";
import { assertCollab } from "./util";

function createBridge({
  account_id,
  defaults,
}: {
  account_id: string;
  defaults?: { projectId?: string; accountId?: string };
}) {
  const conatClientPromise = conat();
  return createLaunchpadAgentSdkBridge({
    hub: {
      system: {
        ping: () => system.ping(),
        getCustomize: (fields?: string[]) => system.getCustomize(fields),
      },
      projects: {
        createProject: (opts) => projects.createProject({ ...opts, account_id }),
      },
    },
    projectResolver: async (projectId: string) => {
      await assertCollab({ account_id, project_id: projectId });
      return projectApiClient({
        project_id: projectId,
        client: await conatClientPromise,
      });
    },
    fsResolver: async (projectId: string) => {
      await assertCollab({ account_id, project_id: projectId });
      return fsClient({
        client: await conatClientPromise,
        subject: fsSubject({ project_id: projectId }),
      });
    },
    defaults: {
      accountId: account_id,
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
}): Promise<AgentCapabilityManifestEntry[]> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return createBridge({ account_id }).manifest();
}

export async function execute(
  opts: AgentExecuteRequest,
): Promise<AgentExecuteResponse> {
  const { account_id } = opts;
  if (!account_id) {
    throw Error("must be signed in");
  }
  const bridge = createBridge({
    account_id,
    defaults: opts.defaults,
  });
  const action = opts.action as AgentActionEnvelope;
  const result = await bridge.execute({
    action,
    actor: {
      ...opts.actor,
      accountId: account_id,
      userId: opts.actor?.userId ?? account_id,
    },
    confirmationToken: opts.confirmationToken,
  });
  return normalizeResult(result);
}
