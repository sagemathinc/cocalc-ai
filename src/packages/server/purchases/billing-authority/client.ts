/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import { conat } from "@cocalc/backend/conat";
import { createServiceClient } from "@cocalc/conat/service/typed";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";

import {
  enableStripeMutationAuthorityEnforcement,
  isInBillingAuthorityContext,
} from "./context";
import type {
  BillingAuthorityApi,
  BillingAuthorityCommand,
  BillingAuthorityHttpOperation,
  BillingAuthorityHubApiCall,
  BillingAuthorityResponse,
} from "./protocol";
import { BILLING_AUTHORITY_SUBJECT } from "./protocol";
export {
  isBillingAuthorityHubApiCall,
  isBillingAuthorityHubApiRead,
  isBillingAuthorityHttpRead,
} from "./classification";
import {
  isBillingAuthorityHubApiRead,
  isBillingAuthorityHttpRead,
} from "./classification";

const BILLING_AUTHORITY_TIMEOUT_MS = 5 * 60_000;

let client:
  | (BillingAuthorityApi & { conat: { waitFor: Function } })
  | undefined;

function authorityClient(): BillingAuthorityApi {
  client ??= createServiceClient<BillingAuthorityApi>({
    client: conat(),
    service: "billing-authority",
    subject: BILLING_AUTHORITY_SUBJECT,
    timeout: BILLING_AUTHORITY_TIMEOUT_MS,
    // Request transport sends exactly once. Fast-RPC's disconnect fallback can
    // repeat a request whose reply was lost, which is unacceptable for money.
    transport: "request",
  });
  return client;
}

function assertSupportedTopology(): void {
  if (!isMultiBayCluster()) return;
  const err = new Error(
    "billing authority is intentionally unavailable in multi-bay mode until financial state is centralized on a designated authority bay",
  );
  Object.assign(err, { code: 503, status: 503 });
  throw err;
}

function unwrap<T>(response: BillingAuthorityResponse): T {
  if (response.ok) return response.value as T;
  const err = new Error(response.error.message);
  Object.assign(err, {
    code: response.error.code,
    status: response.error.status,
  });
  throw err;
}

export async function executeBillingAuthorityCommand<T>(
  command: BillingAuthorityCommand,
  { read = false }: { read?: boolean } = {},
): Promise<T> {
  enableStripeMutationAuthorityEnforcement();
  assertSupportedTopology();
  if (isInBillingAuthorityContext()) {
    const { dispatchBillingAuthorityCommand } = await import("./dispatch");
    return (await dispatchBillingAuthorityCommand(command)) as T;
  }
  const request = { request_id: randomUUID(), command };
  const response = read
    ? await authorityClient().executeRead(request)
    : await authorityClient().executeCommand(request);
  return unwrap<T>(response);
}

export async function executeBillingHttpCommand<T>(
  operation: BillingAuthorityHttpOperation,
  input: Record<string, unknown>,
): Promise<T> {
  return await executeBillingAuthorityCommand<T>(
    {
      kind: "http",
      operation,
      input,
    },
    { read: isBillingAuthorityHttpRead(operation) },
  );
}

export async function executeBillingHubApiCall<T>(
  call: BillingAuthorityHubApiCall,
): Promise<T> {
  return await executeBillingAuthorityCommand<T>(
    { kind: "hub-api", call },
    { read: isBillingAuthorityHubApiRead(call.name) },
  );
}

export function resetBillingAuthorityClientForTests(): void {
  client = undefined;
}
