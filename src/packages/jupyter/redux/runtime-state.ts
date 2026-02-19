/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { type DKO, dko } from "@cocalc/conat/sync/dko";
import type { BackendState, KernelState } from "@cocalc/jupyter/types";
import { ipynbPath } from "@cocalc/util/jupyter/names";

export const JUPYTER_RUNTIME_STATE_VERSION = 1;
export const JUPYTER_RUNTIME_SETTINGS_KEY = "settings";
export const JUPYTER_RUNTIME_NBCONVERT_KEY = "nbconvert";
export const JUPYTER_RUNTIME_LIMITS_KEY = "limits";
export const JUPYTER_RUNTIME_USER_KEY = "user";
export const JUPYTER_RUNTIME_CELL_KEY_PREFIX = "cell:";

export interface JupyterRuntimeSettings {
  backend_state?: BackendState;
  kernel_state?: KernelState;
  last_backend_state?: number;
  kernel_error?: string;
}

export interface JupyterRuntimeNbconvert {
  state?: string;
  args?: string[];
  start?: number;
  time?: number;
  error?: string | null;
}

export interface JupyterRuntimeLimits {
  limit?: number;
}

export interface JupyterRuntimeUserState {
  id?: number;
  time?: number;
}

export interface JupyterRuntimeCellState {
  state?: "done" | "busy" | "run" | null;
  start?: number | null;
  end?: number | null;
}

export interface JupyterRuntimeShape {
  settings?: JupyterRuntimeSettings;
  nbconvert?: JupyterRuntimeNbconvert;
  limits?: JupyterRuntimeLimits;
  user?: JupyterRuntimeUserState;
}

export type JupyterRuntimeState = DKO<JupyterRuntimeShape[keyof JupyterRuntimeShape]>;

export function jupyterRuntimeCellKey(id: string): string {
  return `${JUPYTER_RUNTIME_CELL_KEY_PREFIX}${id}`;
}

export function isJupyterRuntimeCellKey(key: string): boolean {
  return key.startsWith(JUPYTER_RUNTIME_CELL_KEY_PREFIX);
}

export function jupyterRuntimeCellIdFromKey(key: string): string | undefined {
  if (!isJupyterRuntimeCellKey(key)) {
    return;
  }
  return key.slice(JUPYTER_RUNTIME_CELL_KEY_PREFIX.length) || undefined;
}

export function jupyterRuntimeStateName(path: string): string {
  return `jupyter-runtime-v${JUPYTER_RUNTIME_STATE_VERSION}:${ipynbPath(path)}`;
}

export async function openJupyterRuntimeState({
  project_id,
  path,
  client,
}: {
  project_id: string;
  path: string;
  client?: ConatClient;
}): Promise<JupyterRuntimeState> {
  return await dko({
    name: jupyterRuntimeStateName(path),
    project_id,
    client,
    ephemeral: true,
    noInventory: true,
  });
}
