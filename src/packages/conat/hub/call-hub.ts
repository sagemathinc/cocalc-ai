import { type Client } from "@cocalc/conat/core/client";
const DEFAULT_TIMEOUT = 15000;

function errorField(
  err: unknown,
  field: "message" | "error" | "code",
): unknown {
  try {
    return (err as any)?.[field];
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  for (const value of [
    errorField(err, "message"),
    errorField(err, "error"),
    typeof err === "string" ? err : undefined,
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "hub request failed";
}

export function annotateCallHubError({
  err,
  subject,
  name,
}: {
  err: unknown;
  subject: string;
  name: string;
}): Error {
  const code = errorField(err, "code");
  const error = err instanceof Error ? err : new Error(errorMessage(err));
  if (!error.message?.trim()) {
    error.message = errorMessage(err);
  }
  (error as any).code ??= code;
  const codeLabel = code == null ? "unknown" : `${code}`;
  error.message = `${error.message} - callHub: subject='${subject}', name='${name}', code='${codeLabel}'`;
  return error;
}

export default async function callHub({
  client,
  account_id,
  auth_session_hash,
  project_id,
  host_id,
  agent,
  name,
  args = [],
  timeout = DEFAULT_TIMEOUT,
}: {
  client: Client;
  account_id?: string;
  auth_session_hash?: string | null;
  project_id?: string;
  host_id?: string;
  agent?: {
    account_id: string;
    project_id: string;
    token_fingerprint: string;
    issued_at_s: number;
    expires_at_s: number;
  };
  name: string;
  args?: any[];
  timeout?: number;
}) {
  const subject = getSubject({ account_id, project_id, host_id, agent });
  try {
    const data = {
      name,
      args,
      ...(auth_session_hash ? { auth_session_hash } : {}),
    };
    const resp = await client.request(subject, data, { timeout });
    return resp.data;
  } catch (err) {
    throw annotateCallHubError({ err, subject, name });
  }
}

function getSubject({ account_id, project_id, host_id, agent }) {
  if (agent) {
    return `hub.agent.${agent.account_id}.${agent.project_id}.${agent.token_fingerprint}.${agent.issued_at_s}.${agent.expires_at_s}.api`;
  } else if (account_id) {
    return `hub.account.${account_id}.api`;
  } else if (project_id) {
    return `hub.project.${project_id}.api`;
  } else if (host_id) {
    return `hub.host.${host_id}.api`;
  } else {
    throw Error("account_id or project_id or host_id must be specified");
  }
}
