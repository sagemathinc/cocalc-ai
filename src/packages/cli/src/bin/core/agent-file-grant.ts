/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { connect } from "@cocalc/conat/core/client";
import { fsClient, type FilesystemClient } from "@cocalc/conat/files/fs";
import {
  agentFileGrantInboxPrefix,
  parseAgentFileGrantSubject,
  validatePreparedAgentFileGrant,
  type AgentFileGrant,
  type PreparedAgentFileGrant,
} from "@cocalc/conat/agents/file-grants";
import { sendIdentityMessage, readIdentityCredential } from "./agent-message";
import { withTimeout } from "./context";

const SIGN_IN_TIMEOUT_MS = 30_000;

function localProxyAddress(apiUrl: string, projectId: string): string {
  const url = new URL(apiUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${projectId}`.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export async function listAgentFileGrants(
  apiUrl?: string,
): Promise<AgentFileGrant[]> {
  return await sendIdentityMessage(
    { version: 3, action: "file-grants" },
    apiUrl,
  );
}

export async function openAgentFileGrant({
  projectId,
  grantId,
  apiUrl,
}: {
  projectId?: string;
  grantId?: string;
  apiUrl?: string;
}): Promise<{
  prepared: PreparedAgentFileGrant;
  fs: FilesystemClient;
  close: () => void;
}> {
  const prepared = await sendIdentityMessage(
    {
      version: 3,
      action: "prepare-file-grant",
      ...(grantId ? { grant_id: grantId } : { target_project_id: projectId! }),
    },
    apiUrl,
  );
  validatePreparedAgentFileGrant(prepared);
  const binding = parseAgentFileGrantSubject(prepared.subject)!;
  const credential = await readIdentityCredential();
  const baseApi = apiUrl || credential.api_url || process.env.COCALC_API_URL;
  const address = prepared.connection.local_proxy
    ? baseApi
      ? localProxyAddress(baseApi, prepared.grant.target_project_id)
      : ""
    : `${prepared.connection.connect_url ?? ""}`.trim();
  if (!address) throw new Error("file grant target has no connection address");
  const client = connect({
    address,
    noCache: true,
    reconnection: false,
    rejectUnauthorized: true,
    auth: { bearer: prepared.token },
    inboxPrefix: agentFileGrantInboxPrefix(binding),
  });
  try {
    await withTimeout(
      client.waitUntilSignedIn({ timeout: SIGN_IN_TIMEOUT_MS }),
      SIGN_IN_TIMEOUT_MS,
      "timeout while connecting to the file grant target",
    );
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    prepared,
    fs: fsClient({ client, subject: prepared.subject, timeout: 30_000 }),
    close: () => client.close(),
  };
}
