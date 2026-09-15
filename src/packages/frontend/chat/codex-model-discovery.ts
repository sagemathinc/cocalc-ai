import type {
  CodexModelCapabilityInfo,
  CodexPaymentSourceInfo,
} from "@cocalc/conat/hub/api/system";
import { redux } from "@cocalc/frontend/app-framework";
import {
  getLiveCodexUsageStatus,
  readCachedCodexModelCatalog,
  writeCachedCodexModelCatalog,
} from "@cocalc/frontend/account/codex-usage";
import { fetchCodexPaymentSourceForSubmit } from "./use-codex-payment-source";

export function preferredAvailableCodexModel(
  models: CodexModelCapabilityInfo[] | undefined,
  preferred?: string,
  rejected?: string,
): CodexModelCapabilityInfo | undefined {
  const available = models?.filter(({ model }) => model && model !== rejected);
  return (
    available?.find(({ model }) => model === preferred) ??
    available?.find((model) => model.default) ??
    available?.[0]
  );
}

function scope(projectId: string, paymentSource?: CodexPaymentSourceInfo) {
  return {
    accountId: redux.getStore("account")?.get("account_id"),
    projectId,
    runtimeVersion: redux
      .getStore("projects")
      ?.getIn(["project_map", projectId, "state", "tools_version"]) as
      | string
      | undefined,
    subscriptionRevision: paymentSource?.subscriptionRevision,
  };
}

export function cachedAccountCodexModels(
  projectId: string,
  paymentSource?: CodexPaymentSourceInfo,
) {
  if (paymentSource?.source !== "subscription") return undefined;
  const cacheScope = scope(projectId, paymentSource);
  if (!cacheScope.accountId) return undefined;
  return readCachedCodexModelCatalog(cacheScope)?.models;
}

const inflight = new Map<
  string,
  Promise<CodexModelCapabilityInfo[] | undefined>
>();
const generations = new Map<string, number>();

export async function discoverAccountCodexModels(
  projectId: string,
  paymentSource?: CodexPaymentSourceInfo,
  force = false,
): Promise<CodexModelCapabilityInfo[] | undefined> {
  const source =
    paymentSource ?? (await fetchCodexPaymentSourceForSubmit({ projectId }));
  if (source.source !== "subscription") return undefined;
  const cacheScope = scope(projectId, source);
  if (!cacheScope.accountId || !cacheScope.subscriptionRevision)
    return undefined;
  const cached = !force && readCachedCodexModelCatalog(cacheScope);
  if (cached) return cached.models;
  const key = JSON.stringify([cacheScope, force]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const scopeKey = JSON.stringify(cacheScope);
  const generation = (generations.get(scopeKey) ?? 0) + (force ? 1 : 0);
  generations.set(scopeKey, generation);
  const promise = (async () => {
    const status = await getLiveCodexUsageStatus({
      projectId,
      includeModels: true,
      refreshModels: force,
    });
    // Project-host usage responses do not currently include the credential
    // revision. Recheck it through the authoritative payment-source endpoint
    // rather than trusting an in-flight catalog after a credential change.
    const currentSource = await fetchCodexPaymentSourceForSubmit({ projectId });
    if (
      generations.get(scopeKey) !== generation ||
      scope(projectId, source).accountId !== cacheScope.accountId ||
      scope(projectId, source).runtimeVersion !== cacheScope.runtimeVersion ||
      status.paymentSource.source !== "subscription" ||
      currentSource.source !== "subscription" ||
      currentSource.subscriptionRevision !== cacheScope.subscriptionRevision ||
      (status.paymentSource.subscriptionRevision != null &&
        status.paymentSource.subscriptionRevision !==
          cacheScope.subscriptionRevision)
    )
      return undefined;
    writeCachedCodexModelCatalog({ ...cacheScope, models: status.models });
    return status.models;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

// Model discovery can take tens of seconds. Never block a first send on it.
export async function accountAwareCodexDefault(
  projectId: string,
  preferred: string,
): Promise<string> {
  try {
    const source = await fetchCodexPaymentSourceForSubmit({ projectId });
    const models = cachedAccountCodexModels(projectId, source);
    if (!models)
      void discoverAccountCodexModels(projectId, source).catch(() => undefined);
    return preferredAvailableCodexModel(models, preferred)?.model ?? preferred;
  } catch {
    return preferred;
  }
}
