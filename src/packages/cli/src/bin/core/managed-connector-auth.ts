/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";
import { readApiKeyFile } from "./api-key-file";

export interface ManagedConnectorCredential {
  keyFile: string;
  sourceProjectId: string;
}

export function managedConnectorCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ManagedConnectorCredential | undefined {
  const keyFile = `${env.COCALC_CONNECTOR_API_KEY_FILE ?? ""}`.trim();
  if (!keyFile) return;
  const sourceProjectId = `${env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (!isValidUUID(sourceProjectId)) {
    throw new Error("managed CoCalc connector has no valid source project");
  }
  return { keyFile, sourceProjectId };
}

export function readManagedConnectorKey(keyFile: string): string {
  try {
    return readApiKeyFile(keyFile);
  } catch {
    throw new Error(
      "managed CoCalc connector credential is unavailable or file is invalid",
    );
  }
}

export function defaultApiKey({
  explicitKey,
  envKey,
  managedConnector,
}: {
  explicitKey?: string;
  envKey?: string;
  managedConnector?: ManagedConnectorCredential;
}): string | undefined {
  return (
    explicitKey?.trim() || (!managedConnector ? envKey?.trim() : undefined)
  );
}

export function apiKeyForProject(
  ctx: {
    apiKey?: string;
    managedConnector?: ManagedConnectorCredential;
  },
  projectId?: string,
): string | undefined {
  if (ctx.apiKey) return ctx.apiKey;
  const managed = ctx.managedConnector;
  if (!managed || projectId === managed.sourceProjectId) return;
  return readManagedConnectorKey(managed.keyFile);
}
