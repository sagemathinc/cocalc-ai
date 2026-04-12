/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { isValidUUID } from "@cocalc/util/misc";

const SERVICE_NAME = "document-activity";
const DEFAULT_TIMEOUT = 15_000;

export type DocumentActivityAction = "open" | "edit" | "chat";

export interface RecentProjectDocumentActivityEntry {
  project_id: string;
  path: string;
  last_accessed?: string | null;
  recent_account_ids?: string[];
}

export interface FileUseTimesOptions {
  target_account_id?: string;
  limit?: number;
  access_times?: boolean;
  edit_times?: boolean;
  timeout?: number;
}

export interface FileUseTimesResponse {
  target_account_id: string;
  access_times?: number[];
  edit_times?: (number | undefined)[];
}

function requireExplicitConatClient(client?: ConatClient): ConatClient {
  if (client != null) {
    return client;
  }
  throw new Error("must provide an explicit Conat client");
}

function requireAccountId(account_id: string): string {
  if (!isValidUUID(account_id)) {
    throw new Error(`account_id = '${account_id}' must be a valid uuid`);
  }
  return account_id;
}

function requireProjectId(project_id: string): string {
  if (!isValidUUID(project_id)) {
    throw new Error(`project_id = '${project_id}' must be a valid uuid`);
  }
  return project_id;
}

export function getSubject({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): string {
  return [
    "services",
    `account-${requireAccountId(account_id)}`,
    "_",
    requireProjectId(project_id),
    "_",
    SERVICE_NAME,
  ].join(".");
}

async function callDocumentActivity<T>({
  client,
  account_id,
  project_id,
  name,
  args = [],
  timeout = DEFAULT_TIMEOUT,
}: {
  client?: ConatClient;
  account_id: string;
  project_id: string;
  name: string;
  args?: any[];
  timeout?: number;
}): Promise<T> {
  const subject = getSubject({ account_id, project_id });
  const resp = await requireExplicitConatClient(client).request(
    subject,
    [name, args],
    { timeout, waitForInterest: true },
  );
  return resp.data as T;
}

export async function markFile({
  client,
  account_id,
  project_id,
  path,
  action,
  timeout,
}: {
  client?: ConatClient;
  account_id: string;
  project_id: string;
  path: string;
  action: DocumentActivityAction;
  timeout?: number;
}): Promise<void> {
  await callDocumentActivity<null>({
    client,
    account_id,
    project_id,
    timeout,
    name: "markFile",
    args: [{ path, action }],
  });
}

export async function listRecent({
  client,
  account_id,
  project_id,
  limit,
  max_age_s,
  search,
  timeout,
}: {
  client?: ConatClient;
  account_id: string;
  project_id: string;
  limit?: number;
  max_age_s?: number;
  search?: string;
  timeout?: number;
}): Promise<RecentProjectDocumentActivityEntry[]> {
  return await callDocumentActivity<RecentProjectDocumentActivityEntry[]>({
    client,
    account_id,
    project_id,
    timeout,
    name: "listRecent",
    args: [{ limit, max_age_s, search }],
  });
}

export async function getFileUseTimes({
  client,
  account_id,
  project_id,
  path,
  target_account_id,
  limit,
  access_times,
  edit_times,
  timeout,
}: {
  client?: ConatClient;
  account_id: string;
  project_id: string;
  path: string;
  target_account_id?: string;
  limit?: number;
  access_times?: boolean;
  edit_times?: boolean;
  timeout?: number;
}): Promise<FileUseTimesResponse> {
  return await callDocumentActivity<FileUseTimesResponse>({
    client,
    account_id,
    project_id,
    timeout,
    name: "getFileUseTimes",
    args: [{ path, target_account_id, limit, access_times, edit_times }],
  });
}
