/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { isValidUUID } from "@cocalc/util/misc";
import {
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  ANTHROPIC_API_KEY_KIND,
  ANTHROPIC_API_KEY_PROFILE_ID,
  ANTHROPIC_API_PROVIDER,
} from "@cocalc/util/ai/external-credential-profiles";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import {
  createCredentialHttpRelay,
  type CredentialHttpRelay,
} from "./credential-http-relay";

const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

export async function createAnthropicAccountCredentialRelay({
  projectId,
  accountId,
  credentialId,
  socketPath,
}: {
  projectId: string;
  accountId: string;
  credentialId: string;
  socketPath: string;
}): Promise<CredentialHttpRelay> {
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    !isValidUUID(credentialId)
  ) {
    throw Error("Invalid Anthropic credential relay binding");
  }
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    throw Error(
      "Anthropic credentials are unavailable while the host is disconnected",
    );
  }
  const selector = {
    provider: ANTHROPIC_API_PROVIDER,
    kind: ANTHROPIC_API_KEY_KIND,
    scope: "account" as const,
    owner_account_id: accountId,
  };
  const credential = await callHub({
    client,
    host_id,
    name: "hosts.getExternalCredential",
    args: [
      {
        project_id: projectId,
        selector,
        credential_id: credentialId,
      },
    ],
    timeout: 15_000,
  });
  if (
    credential?.id !== credentialId ||
    credential?.metadata?.[ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY] !==
      ANTHROPIC_API_KEY_PROFILE_ID ||
    typeof credential?.payload !== "string" ||
    !credential.payload.trim()
  ) {
    throw Error("Anthropic credential is unavailable or revoked");
  }
  const relay = await createCredentialHttpRelay({
    socketPath,
    upstream: ANTHROPIC_API_ORIGIN,
    allowedPathPrefix: "/v1/",
    allowedMethods: ["GET", "POST"],
    credential: { header: "x-api-key", value: credential.payload.trim() },
  });
  try {
    const touched = await callHub({
      client,
      host_id,
      name: "hosts.touchExternalCredential",
      args: [
        {
          project_id: projectId,
          selector,
          credential_id: credentialId,
        },
      ],
      timeout: 15_000,
    });
    if (!touched) throw Error("credential authority changed during admission");
    return relay;
  } catch {
    await relay.close();
    throw Error("Anthropic credential is unavailable or revoked");
  }
}
