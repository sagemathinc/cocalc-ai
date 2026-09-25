/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isValidUUID } from "@cocalc/util/misc";

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
  const fd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("managed CoCalc connector credential file is invalid");
    }
    const secret = readFileSync(fd, "utf8").trim();
    if (!secret || secret.length > 4096 || /\s/.test(secret)) {
      throw new Error("managed CoCalc connector credential is invalid");
    }
    return secret;
  } finally {
    closeSync(fd);
  }
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
