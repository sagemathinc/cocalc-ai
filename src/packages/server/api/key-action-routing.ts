/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  ApiKeyActionPrincipal,
  ApiKeyActionDecision,
} from "@cocalc/util/api-key-management";
import { normalizeApiKeyActionRequest } from "@cocalc/util/api-key-management";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  requestApiKeyActionLocal,
  decideApiKeyActionLocal,
  listApiKeyActionsLocal,
} from "./key-actions";

async function remote(account_id: string) {
  const home = (await getClusterAccountById(account_id))?.home_bay_id;
  if (!home) throw new Error("unable to resolve API key action account home");
  if (home === getConfiguredBayId()) return;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home,
    timeout: 5_000,
  });
}

export async function requestApiKeyAction(
  principal: ApiKeyActionPrincipal,
  input: unknown,
) {
  const request = normalizeApiKeyActionRequest(input);
  // Forward only authenticated identity, never bearer secrets or client scopes.
  const identity: ApiKeyActionPrincipal = {
    account_id: principal.account_id,
    api_key_id: principal.api_key_id,
    key_id: principal.key_id,
    scope_revision: principal.scope_revision,
    auth_method: principal.auth_method,
  };
  const client = await remote(identity.account_id);
  return client
    ? client.requestApiKeyAction({ principal: identity, request })
    : requestApiKeyActionLocal(identity, request);
}

export async function decideApiKeyAction(opts: ApiKeyActionDecision) {
  const client = await remote(opts.account_id);
  return client
    ? client.decideApiKeyAction(opts)
    : decideApiKeyActionLocal(opts);
}

export async function listApiKeyActions(opts: {
  account_id: string;
  session_hash: string;
}) {
  const client = await remote(opts.account_id);
  return client ? client.listApiKeyActions(opts) : listApiKeyActionsLocal(opts);
}
