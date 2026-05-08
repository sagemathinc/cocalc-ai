import { type Client } from "@cocalc/conat/core/client";
const DEFAULT_TIMEOUT = 15000;

export default async function callHub({
  client,
  account_id,
  auth_session_hash,
  project_id,
  host_id,
  name,
  args = [],
  timeout = DEFAULT_TIMEOUT,
}: {
  client: Client;
  account_id?: string;
  auth_session_hash?: string | null;
  project_id?: string;
  host_id?: string;
  name: string;
  args?: any[];
  timeout?: number;
}) {
  const subject = getSubject({ account_id, project_id, host_id });
  try {
    const data = {
      name,
      args,
      ...(auth_session_hash ? { auth_session_hash } : {}),
    };
    const resp = await client.request(subject, data, { timeout });
    return resp.data;
  } catch (err) {
    const code = (err as any)?.code;
    const error =
      err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : `${err}`);
    (error as any).code ??= code;
    error.message = `${error.message} - callHub: subject='${subject}', name='${name}', code='${code}' `;
    throw error;
  }
}

function getSubject({ account_id, project_id, host_id }) {
  if (account_id) {
    return `hub.account.${account_id}.api`;
  } else if (project_id) {
    return `hub.project.${project_id}.api`;
  } else if (host_id) {
    return `hub.host.${host_id}.api`;
  } else {
    throw Error("account_id or project_id or host_id must be specified");
  }
}
