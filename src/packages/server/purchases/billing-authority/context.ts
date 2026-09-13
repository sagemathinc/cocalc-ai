/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface BillingAuthorityContext {
  operation: string;
  request_id: string;
}

interface StoredBillingAuthorityContext extends BillingAuthorityContext {
  active: boolean;
  authority_active: () => boolean;
}

const storage = new AsyncLocalStorage<StoredBillingAuthorityContext>();
// Production and development processes fail closed even if a new caller forgets
// to initialize the authority client. Tests opt in so existing unit tests can
// continue to exercise isolated billing functions with mocked Stripe clients.
export function stripeMutationEnforcementDefault(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== "test";
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

export async function runInBillingAuthorityContext<T>({
  operation,
  request_id,
  authority_active = () => true,
  fn,
}: BillingAuthorityContext & {
  authority_active?: () => boolean;
  fn: () => Promise<T>;
}): Promise<T> {
  if (activeContext() != null) {
    return await fn();
  }
  const context = { operation, request_id, active: true, authority_active };
  try {
    return await storage.run(context, fn);
  } finally {
    // AsyncLocalStorage also propagates into detached work. Expiring this
    // shared token prevents a fire-and-forget continuation from retaining the
    // Stripe mutation capability after its serialized command has completed.
    context.active = false;
  }
}

export function assertStripeMutationAuthorized({
  method,
  path,
}: {
  method: string;
  path: string;
}): void {
  if (!stripeMutationEnforcementEnabled || activeContext() != null) {
    return;
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
