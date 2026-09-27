import { type Client } from "@cocalc/conat/core/client";
import { ConatError } from "@cocalc/conat/util";
import { resolveHostConnectionSingleFlight } from "./resolve-host-singleflight";
const DEFAULT_TIMEOUT = 15000;

// Share resolver work across SDK calls and the browser's direct fallback. Other
// RPCs (especially token issuance) must retain their own scope and semantics.
export function requestHub(
  client: Client,
  subject: string,
  data: { name: string; args: any[]; auth_session_hash?: string },
  options: { timeout: number },
) {
  const request = () => client.request(subject, data, options);
  if (data.name !== "hosts.resolveHostConnection") return request();
  const flight = resolveHostConnectionSingleFlight(
    client,
    [
      subject,
      data.auth_session_hash ?? client.info?.user?.auth_session_hash,
      client.info?.user,
    ],
    data.args,
    request,
  );
  // A joiner has its own deadline, but timing out its wait must not evict or
  // cancel the underlying RPC. Only the single-flight helper owns that entry.
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    flight,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ConatError("timeout", { code: 408, subject }));
      }, options.timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  const context = ` - callHub: subject='${subject}', name='${name}', code='${codeLabel}'`;
  // A single failed resolver RPC can now have many callHub waiters.
  if (!error.message.endsWith(context)) error.message += context;
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
    const resp = await requestHub(client, subject, data, { timeout });
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
