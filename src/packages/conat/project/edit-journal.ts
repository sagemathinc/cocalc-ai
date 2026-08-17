/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { CompressedPatch } from "@cocalc/util/dmp";
import { isValidUUID } from "@cocalc/util/misc";

const SERVICE_NAME = "edit-journal";
const DEFAULT_TIMEOUT = 30_000;
const availability = new WeakMap<ConatClient, Map<string, Promise<boolean>>>();

export interface EditJournalIdentity {
  account_id: string;
  project_id: string;
}

export interface EditJournalBatch {
  journal_id: string;
  sequence: number;
}

export interface TextJournalSaveRequest extends EditJournalBatch {
  path: string;
  base_sha256: string;
  patch: CompressedPatch;
}

export interface NotebookCellJournalPatch {
  cell_id: string;
  patch: CompressedPatch;
}

export interface NotebookJournalSaveRequest extends EditJournalBatch {
  path: string;
  base_sha256: string;
  contents: string;
  cell_patches: NotebookCellJournalPatch[];
}

export interface EditJournalSaveResponse {
  committed: boolean;
  contents: string;
  sha256: string;
  time?: string;
}

function requireUuid(name: string, value: string): string {
  if (!isValidUUID(value)) {
    throw new Error(`${name} must be a valid uuid`);
  }
  return value;
}

export function editJournalSubject({
  account_id,
  project_id,
}: EditJournalIdentity): string {
  return [
    "services",
    `account-${requireUuid("account_id", account_id)}`,
    "_",
    requireUuid("project_id", project_id),
    "_",
    SERVICE_NAME,
  ].join(".");
}

export function parseEditJournalSubject(subject?: string): EditJournalIdentity {
  const parts = `${subject ?? ""}`.split(".");
  if (
    parts.length !== 6 ||
    parts[0] !== "services" ||
    parts[5] !== SERVICE_NAME
  ) {
    throw new Error(`invalid edit journal subject '${subject ?? ""}'`);
  }
  const account_id = parts[1]?.startsWith("account-")
    ? parts[1].slice("account-".length)
    : "";
  return {
    account_id: requireUuid("account_id", account_id),
    project_id: requireUuid("project_id", parts[3] ?? ""),
  };
}

export async function editJournalAvailable({
  client,
  account_id,
  project_id,
}: EditJournalIdentity & { client: ConatClient }): Promise<boolean> {
  if (typeof client.interest !== "function") return true;
  const subject = editJournalSubject({ account_id, project_id });
  let clientAvailability = availability.get(client);
  if (!clientAvailability) {
    clientAvailability = new Map();
    availability.set(client, clientAvailability);
  }
  let result = clientAvailability.get(subject);
  if (!result) {
    result = client.interest(subject).catch(() => false);
    clientAvailability.set(subject, result);
  }
  return await result;
}

async function callEditJournal<T>({
  client,
  identity,
  name,
  args,
  timeout = DEFAULT_TIMEOUT,
}: {
  client: ConatClient;
  identity: EditJournalIdentity;
  name: string;
  args: unknown[];
  timeout?: number;
}): Promise<T> {
  const response = await client.request(
    editJournalSubject(identity),
    [name, args],
    { timeout, waitForInterest: true },
  );
  return response.data as T;
}

export async function saveTextJournal({
  client,
  account_id,
  project_id,
  request,
  timeout,
}: EditJournalIdentity & {
  client: ConatClient;
  request: TextJournalSaveRequest;
  timeout?: number;
}): Promise<EditJournalSaveResponse> {
  return await callEditJournal({
    client,
    identity: { account_id, project_id },
    name: "saveText",
    args: [request],
    timeout,
  });
}

export async function saveNotebookJournal({
  client,
  account_id,
  project_id,
  request,
  timeout,
}: EditJournalIdentity & {
  client: ConatClient;
  request: NotebookJournalSaveRequest;
  timeout?: number;
}): Promise<EditJournalSaveResponse> {
  return await callEditJournal({
    client,
    identity: { account_id, project_id },
    name: "saveNotebook",
    args: [request],
    timeout,
  });
}
