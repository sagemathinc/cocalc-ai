/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { isBillingAuthorityEnabled } from "./config";

export interface BillingAuthorityProviderMutationTracker {
  sequence: number;
  started: boolean;
  successful: boolean;
  ambiguous_keys: Set<string>;
  known_keys: Set<string>;
  caller_key_aliases: Map<string, string>;
  anonymous_key_aliases: Map<string, string>;
  anonymous_fingerprint_by_key: Map<string, string>;
}

interface BillingAuthorityContext {
  operation: string;
  request_id: string;
}

interface StoredBillingAuthorityContext extends BillingAuthorityContext {
  active: boolean;
  authority_active: () => boolean;
  assert_authority: () => Promise<void>;
  record_provider_start?: () => Promise<void>;
  register_account: (account_id: string) => Promise<void>;
  registered_accounts: Set<string>;
  provider_tracker: BillingAuthorityProviderMutationTracker;
}

const storage = new AsyncLocalStorage<StoredBillingAuthorityContext>();
// Once the rollout gate is enabled, production and development fail closed
// even if a caller forgets to initialize the authority client. Tests opt in so
// isolated billing functions can continue to use mocked Stripe clients.
export function stripeMutationEnforcementDefault(
  nodeEnv: string | undefined,
  authorityEnabled = isBillingAuthorityEnabled(),
): boolean {
  return authorityEnabled && nodeEnv !== "test";
}

let stripeMutationEnforcementEnabled = stripeMutationEnforcementDefault(
  process.env.NODE_ENV,
);

function activeContext(): StoredBillingAuthorityContext | undefined {
  const context = storage.getStore();
  return context?.active && context.authority_active() ? context : undefined;
}

export function enableStripeMutationAuthorityEnforcement(): void {
  stripeMutationEnforcementEnabled = true;
}

export function isStripeMutationAuthorityEnforcementEnabled(): boolean {
  return stripeMutationEnforcementEnabled;
}

export function isInBillingAuthorityContext(): boolean {
  return activeContext() != null;
}

export function getBillingAuthorityContext():
  | BillingAuthorityContext
  | undefined {
  const context = activeContext();
  if (!context) return undefined;
  return { operation: context.operation, request_id: context.request_id };
}

export function createBillingAuthorityProviderMutationTracker(): BillingAuthorityProviderMutationTracker {
  return {
    sequence: 0,
    started: false,
    successful: false,
    ambiguous_keys: new Set(),
    known_keys: new Set(),
    caller_key_aliases: new Map(),
    anonymous_key_aliases: new Map(),
    anonymous_fingerprint_by_key: new Map(),
  };
}

export function getBillingAuthorityProviderMutationOutcome(
  tracker: BillingAuthorityProviderMutationTracker,
): { started: boolean; successful: boolean; ambiguous: boolean } {
  return {
    started: tracker.started,
    successful: tracker.successful,
    ambiguous: tracker.ambiguous_keys.size > 0,
  };
}

export async function runInBillingAuthorityContext<T>({
  operation,
  request_id,
  authority_active = () => true,
  assert_authority = async () => undefined,
  record_provider_start,
  register_account = async () => undefined,
  pre_registered_accounts = [],
  provider_tracker = createBillingAuthorityProviderMutationTracker(),
  fn,
}: BillingAuthorityContext & {
  authority_active?: () => boolean;
  assert_authority?: () => Promise<void>;
  record_provider_start?: () => Promise<void>;
  register_account?: (account_id: string) => Promise<void>;
  pre_registered_accounts?: Iterable<string>;
  provider_tracker?: BillingAuthorityProviderMutationTracker;
  fn: () => Promise<T>;
}): Promise<T> {
  if (activeContext() != null) {
    return await fn();
  }
  const context = {
    operation,
    request_id,
    active: true,
    authority_active,
    assert_authority,
    record_provider_start,
    register_account,
    registered_accounts: new Set(
      [...pre_registered_accounts].map((account_id) =>
        `${account_id}`.trim().toLowerCase(),
      ),
    ),
    provider_tracker,
  };
  try {
    return await storage.run(context, fn);
  } finally {
    // AsyncLocalStorage also propagates into detached work. Expiring this
    // shared token prevents a fire-and-forget continuation from retaining the
    // Stripe mutation capability after its serialized command has completed.
    context.active = false;
  }
}

export async function registerBillingAuthorityAccount(
  account_id: string,
  { allow_direct_execution = false }: { allow_direct_execution?: boolean } = {},
): Promise<void> {
  const context = storage.getStore();
  if (!context) {
    if (isBillingAuthorityEnabled() && !allow_direct_execution) {
      throw Object.assign(
        new Error("billing account registration requires the authority"),
        { code: 503, status: 503 },
      );
    }
    return;
  }
  if (!context.active || !context.authority_active()) {
    throw Object.assign(new Error("billing authority context expired"), {
      code: 503,
      status: 503,
    });
  }
  await context.assert_authority();
  if (!context.active || !context.authority_active()) {
    throw Object.assign(new Error("billing authority context expired"), {
      code: 503,
      status: 503,
    });
  }
  const normalized = `${account_id}`.trim().toLowerCase();
  if (context.registered_accounts.has(normalized)) return;
  await context.register_account(normalized);
  context.registered_accounts.add(normalized);
}

export async function assertBillingAuthorityAccountRegistered(
  account_id: string,
  { allow_direct_execution = false }: { allow_direct_execution?: boolean } = {},
): Promise<void> {
  const context = storage.getStore();
  if (!context) {
    if (isBillingAuthorityEnabled() && !allow_direct_execution) {
      throw Object.assign(
        new Error("financial ledger mutation requires the billing authority"),
        { code: 503, status: 503 },
      );
    }
    return;
  }
  if (!context.active || !context.authority_active()) {
    throw Object.assign(new Error("billing authority context expired"), {
      code: 503,
      status: 503,
    });
  }
  await context.assert_authority();
  const normalized = `${account_id}`.trim().toLowerCase();
  if (
    !context.active ||
    !context.authority_active() ||
    !context.registered_accounts.has(normalized)
  ) {
    throw Object.assign(
      new Error("billing account was not fenced before ledger mutation"),
      { code: 503, status: 503 },
    );
  }
}

function providerIdempotencyKey({
  request_id,
  sequence,
  method,
  path,
  body,
  caller_key,
}: {
  request_id: string;
  sequence: number;
  method: string;
  path: string;
  body: string;
  caller_key?: string;
}): string {
  // A caller key already identifies the logical provider mutation. Do not mix
  // in call order: recovery can legitimately skip work that completed during
  // an earlier attempt (for example, Stripe customer creation).
  const identity = caller_key
    ? { version: 3, caller_key }
    : {
        version: 1,
        request_id,
        sequence,
        method: method.toUpperCase(),
        path,
        body,
        caller_key: null,
      };
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return `cocalc-ba-v2-${hash}`;
}

export async function beginStripeMutation({
  method,
  path,
  body,
  existing_key,
}: {
  method: string;
  path: string;
  body: string;
  existing_key?: string;
}): Promise<string> {
  await assertStripeMutationAuthorized({ method, path });
  const context = activeContext();
  if (!context) {
    throw Object.assign(new Error("billing authority context expired"), {
      code: 503,
      status: 503,
    });
  }
  const tracker = context.provider_tracker;
  if (!tracker.started) {
    if (context.record_provider_start) {
      await context.record_provider_start();
    } else if (isBillingAuthorityEnabled()) {
      throw Object.assign(
        new Error("billing authority provider journal is unavailable"),
        { code: 503, status: 503 },
      );
    }
    if (!context.active || !context.authority_active()) {
      throw Object.assign(new Error("billing authority context expired"), {
        code: 503,
        status: 503,
      });
    }
    tracker.started = true;
  }
  if (existing_key && tracker.known_keys.has(existing_key)) {
    return existing_key;
  }
  const anonymousFingerprint = existing_key
    ? undefined
    : createHash("sha256")
        .update(
          JSON.stringify({
            method: method.toUpperCase(),
            path,
            body,
          }),
        )
        .digest("hex");
  const aliased = existing_key
    ? tracker.caller_key_aliases.get(existing_key)
    : tracker.anonymous_key_aliases.get(anonymousFingerprint!);
  if (aliased) return aliased;
  tracker.sequence += 1;
  const key = providerIdempotencyKey({
    request_id: context.request_id,
    sequence: tracker.sequence,
    method,
    path,
    body,
    caller_key: existing_key,
  });
  tracker.known_keys.add(key);
  if (existing_key) {
    // Stripe copies its prepared headers for each network retry. Its original
    // idempotency key is stable across those copies, so retain an alias to the
    // authority key rather than relying on mutating one headers object.
    tracker.caller_key_aliases.set(existing_key, key);
  } else {
    // V1 DELETE and a few nonstandard mutations have no Stripe-generated key.
    // Reuse their fingerprint only while the outcome is unresolved; a
    // definitive response removes it so a later intentional equal operation
    // still receives a distinct key.
    tracker.anonymous_key_aliases.set(anonymousFingerprint!, key);
    tracker.anonymous_fingerprint_by_key.set(key, anonymousFingerprint!);
  }
  return key;
}

export function finishStripeMutation({
  key,
  status,
  ambiguous = false,
}: {
  key: string;
  status?: number;
  ambiguous?: boolean;
}): void {
  const context = storage.getStore();
  if (!context) return;
  if (
    ambiguous ||
    status == null ||
    status === 408 ||
    status === 409 ||
    status >= 500
  ) {
    context.provider_tracker.ambiguous_keys.add(key);
    return;
  }
  const anonymousFingerprint =
    context.provider_tracker.anonymous_fingerprint_by_key.get(key);
  if (anonymousFingerprint) {
    context.provider_tracker.anonymous_fingerprint_by_key.delete(key);
    context.provider_tracker.anonymous_key_aliases.delete(anonymousFingerprint);
  }
  if (status != null && status >= 200 && status < 300) {
    context.provider_tracker.successful = true;
    context.provider_tracker.ambiguous_keys.delete(key);
  }
}

export async function assertStripeMutationAuthorized({
  method,
  path,
}: {
  method: string;
  path: string;
}): Promise<void> {
  if (!stripeMutationEnforcementEnabled) {
    return;
  }
  const context = activeContext();
  if (context != null) {
    await context.assert_authority();
    if (activeContext() != null) return;
  }
  const err = new Error(
    `Stripe ${method.toUpperCase()} ${path} must run through the billing authority`,
  );
  Object.assign(err, { code: 503, status: 503 });
  throw err;
}

export function resetBillingAuthorityContextForTests(): void {
  stripeMutationEnforcementEnabled = false;
  storage.disable();
}
