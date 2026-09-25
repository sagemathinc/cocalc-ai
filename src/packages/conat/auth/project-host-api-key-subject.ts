/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";

export const API_KEY_VIEWER_FILE_SERVICE = "fs-api-key";

export interface ApiKeyViewerFsSubject {
  project_id: string;
  account_id: string;
  key_id: string;
  scope_revision: number;
  viewer_policy_hash: string;
}

export function apiKeyViewerFsSubject(value: ApiKeyViewerFsSubject): string {
  const { project_id, account_id, key_id, scope_revision, viewer_policy_hash } =
    value;
  if (
    !isValidUUID(project_id) ||
    !isValidUUID(account_id) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(key_id) ||
    !Number.isSafeInteger(scope_revision) ||
    scope_revision < 1 ||
    !/^[a-f0-9]{64}$/.test(viewer_policy_hash)
  ) {
    throw new Error("invalid API key viewer subject");
  }
  return `${API_KEY_VIEWER_FILE_SERVICE}.project-${project_id}.account-${account_id}.key-${key_id}.rev-${scope_revision}.hash-${viewer_policy_hash}`;
}

export function parseApiKeyViewerFsSubject(
  subject: string,
): ApiKeyViewerFsSubject | undefined {
  const parts = subject.split(".");
  if (parts.length !== 6 || parts[0] !== API_KEY_VIEWER_FILE_SERVICE) return;
  if (
    !parts[1].startsWith("project-") ||
    !parts[2].startsWith("account-") ||
    !parts[3].startsWith("key-") ||
    !parts[4].startsWith("rev-") ||
    !parts[5].startsWith("hash-")
  ) {
    return;
  }
  const value = {
    project_id: parts[1].slice(8),
    account_id: parts[2].slice(8),
    key_id: parts[3].slice(4),
    scope_revision: Number(parts[4].slice(4)),
    viewer_policy_hash: parts[5].slice(5),
  };
  try {
    if (apiKeyViewerFsSubject(value) === subject) return value;
  } catch {
    return;
  }
}
