/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: a user's own GPU provider API key (RunPod first),
kept in the external-credentials broker on their home bay. CoCalc uses it to
launch and manage GPUs on their behalf; the key itself is never shown again,
to them or to anyone they share GPUs with.
*/

export const GPU_PROVIDERS = ["runpod"] as const;
export type GpuProvider = (typeof GPU_PROVIDERS)[number];

export const GPU_PROVIDER_LABELS: Record<GpuProvider, string> = {
  runpod: "RunPod",
};

// The external-credentials kind; the provider is the GpuProvider id.
export const GPU_PROVIDER_API_KEY_KIND = "gpu-provider-api-key";

// How long the browser waits for setGpuProviderKey: well past the server's
// verification deadline (25 s, after which it stores nothing) plus the store,
// which waits on the database and the selector lock without its own deadline.
// If even this passes, the panel reloads the real status (see
// gpu-provider-key.tsx), so a late store shows up at the next load.
export const VERIFY_RPC_TIMEOUT_MS = 90_000;

// For an account homed on another bay, the whole operation is forwarded to
// the home bay, which may wait this long for it. The browser's wait must
// exceed it: VERIFY_RPC_TIMEOUT_MS for a save, KEY_RPC_TIMEOUT_MS for the
// status and removal (the default 15 s is shorter than one forwarded call
// may take).
export const SET_KEY_HOME_BAY_TIMEOUT_MS = 75_000;
export const KEY_HOME_BAY_TIMEOUT_MS = 30_000;
export const KEY_RPC_TIMEOUT_MS = 45_000;

export function isGpuProvider(value: unknown): value is GpuProvider {
  return GPU_PROVIDERS.includes(value as GpuProvider);
}

export interface GpuProviderAccount {
  kind: "personal" | "organization";
  id: string;
  name?: string;
}

export interface GpuProviderKeyStatus {
  provider: GpuProvider;
  // The account's membership allows connecting a key.
  entitled: boolean;
  connected: boolean;
  // The provider account the key acts for (non-secret), when connected.
  provider_account?: GpuProviderAccount;
  connected_at?: string;
}
