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
// One record per save of the .ipynb file, keyed by the sha1 of the file.
export const JUPYTER_RUNTIME_IPYNB_SAVE_KEY_PREFIX = "ipynb-save:";
// How many recent saves to keep.
export const JUPYTER_RUNTIME_IPYNB_SAVES_KEPT = 16;

// A save of the .ipynb file by a client of the live notebook. A file on disk
// that is one of these is not an external edit, so it is never imported over
// the live notebook (which may already have newer edits than the file).
export interface JupyterRuntimeIpynbSave {
  sha1: string;
  mtimeMs?: number;
  savedAt: number;
}

export interface JupyterRuntimeSettings {
  backend_state?: BackendState;
  kernel_state?: KernelState;
  last_backend_state?: number;
  kernel_error?: string;
}

// The settings record is read field by field rather than through its DKO field
// manifest, since the project's kernel and the browser's optimistic state write
// it concurrently and would otherwise hide each other's values.  Keep in sync
// with JupyterRuntimeSettings.
export const JUPYTER_RUNTIME_SETTINGS_FIELDS = [
  "backend_state",
  "kernel_state",
  "last_backend_state",
  "kernel_error",
] as const satisfies readonly (keyof JupyterRuntimeSettings)[];

export interface JupyterRuntimeNbconvert {
  state?: string;
  args?: string[];
  start?: number;
  time?: number;
  error?: string | null;
  output?: string;
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

export function normalizeJupyterRuntimeCellState(
  runtimeCell: JupyterRuntimeCellState | undefined,
): JupyterRuntimeCellState | undefined {
  if (runtimeCell == null) {
    return;
  }
  if (
    runtimeCell.end == null ||
    runtimeCell.state === "done" ||
    (runtimeCell.start != null && runtimeCell.end < runtimeCell.start)
  ) {
    return runtimeCell;
  }
  return { ...runtimeCell, state: "done" };
}

export function recoverJupyterRuntimeCellState(
  runtimeCell: JupyterRuntimeCellState | undefined,
  unlistedEnd: unknown,
): JupyterRuntimeCellState | undefined {
  if (
    runtimeCell == null ||
    runtimeCell.end != null ||
    typeof unlistedEnd !== "number" ||
    !Number.isFinite(unlistedEnd) ||
    (runtimeCell.start != null && unlistedEnd < runtimeCell.start)
  ) {
    return normalizeJupyterRuntimeCellState(runtimeCell);
  }
  return normalizeJupyterRuntimeCellState({
    ...runtimeCell,
    end: unlistedEnd,
  });
}

export function isActiveJupyterRuntimeCellState(
  runtimeCell: JupyterRuntimeCellState | undefined,
): boolean {
  const state = normalizeJupyterRuntimeCellState(runtimeCell)?.state;
  return state === "run" || state === "busy";
}

export interface JupyterRuntimeShape {
  settings?: JupyterRuntimeSettings;
  nbconvert?: JupyterRuntimeNbconvert;
  limits?: JupyterRuntimeLimits;
  user?: JupyterRuntimeUserState;
}

export type JupyterRuntimeState = DKO<
  JupyterRuntimeShape[keyof JupyterRuntimeShape]
>;

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
  client: ConatClient;
}): Promise<JupyterRuntimeState> {
  return await dko({
    name: jupyterRuntimeStateName(path),
    project_id,
    client,
    ephemeral: true,
    noInventory: true,
  });
}
