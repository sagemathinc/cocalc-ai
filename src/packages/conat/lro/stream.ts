import { lroStreamName } from "@cocalc/conat/lro/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  LroEvent,
  LroScopeType,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";

const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

function requireClient(client?: ConatClient): ConatClient {
  if (client == null) {
    throw new Error("lro stream helpers must provide an explicit Conat client");
  }
  return client;
}

function scopeArgs(scope_type: LroScopeType, scope_id: string) {
  if (scope_type === "project") {
    return { project_id: scope_id };
  }
  if (scope_type === "account") {
    return { account_id: scope_id };
  }
  if (scope_type === "host") {
    return { host_id: scope_id };
  }
  return {};
}

export async function publishLroEvent({
  client,
  scope_type,
  scope_id,
  op_id,
  event,
  ttl = DEFAULT_EVENT_TTL_MS,
}: {
  client: ConatClient;
  scope_type: LroScopeType;
  scope_id: string;
  op_id: string;
  event: LroEvent;
  ttl?: number;
}): Promise<void> {
  const stream = requireClient(client).sync.astream<LroEvent>({
    ...scopeArgs(scope_type, scope_id),
    name: lroStreamName(op_id),
    ephemeral: true,
  });
  await stream.publish(event, { ttl });
}

export async function publishLroSummary({
  client,
  scope_type,
  scope_id,
  summary,
}: {
  client: ConatClient;
  scope_type: LroScopeType;
  scope_id: string;
  summary: LroSummary;
}): Promise<void> {
  await publishLroEvent({
    client,
    scope_type,
    scope_id,
    op_id: summary.op_id,
    event: {
      type: "summary",
      ts: Date.now(),
      summary,
    },
  });
}
