/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { sha1 } from "@cocalc/util/misc";
import type {
  Filesystem,
  JupyterImportIpynbResult,
  JupyterSaveIpynbResult,
} from "@cocalc/conat/files/fs";
import {
  embedCoCalcBlobImages,
  externalizeJupyterAttachments,
  type LoadedBlob,
  type SavedBlob,
} from "./blob-attachments";

const logger = getLogger("jupyter:ipynb:filesystem");

// Native Jupyter attachments are base64 encoded, so this is intentionally
// larger than the 100 MiB decoded attachment limit enforced by the converter.
export const MAX_JUPYTER_IPYNB_RPC_BYTES = 192 * 1024 * 1024;
export const MAX_JUPYTER_IPYNB_CELLS = 100_000;
const MAX_JUPYTER_PATH_BYTES = 4096;
const MAX_PENDING_PER_PROJECT = 8;
const MAX_PENDING_GLOBAL = 64;
const MAX_CONCURRENT_GLOBAL = 4;
const MAX_PENDING_BYTES_PER_PROJECT = 384 * 1024 * 1024;
const MAX_PENDING_BYTES_GLOBAL = 1024 * 1024 * 1024;

export interface JupyterFilesystemBlobStore {
  loadBlob: (opts: {
    project_id: string;
    uuid: string;
  }) => Promise<LoadedBlob | undefined>;
  saveBlob: (opts: {
    project_id: string;
    bytes: Buffer;
    content_id: string;
    filename: string;
    media_type: string;
  }) => Promise<SavedBlob>;
}

const projectTails = new Map<string, Promise<void>>();
const projectPending = new Map<string, number>();
const projectPendingBytes = new Map<string, number>();
let globalPending = 0;
let globalPendingBytes = 0;
let globalActive = 0;
const globalWaiters: Array<() => void> = [];

function codedError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

function validateIpynb(ipynb: object): string {
  if (ipynb == null || typeof ipynb !== "object" || Array.isArray(ipynb)) {
    throw codedError("ipynb must be an object", "EINVAL");
  }
  const cells = (ipynb as any).cells;
  if (cells != null && !Array.isArray(cells)) {
    throw codedError("ipynb cells must be an array", "EINVAL");
  }
  if (cells?.length > MAX_JUPYTER_IPYNB_CELLS) {
    throw codedError(
      `ipynb has too many cells (${cells.length}; max ${MAX_JUPYTER_IPYNB_CELLS})`,
      "E2BIG",
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(ipynb);
  } catch (err) {
    throw codedError(`ipynb is not JSON serializable: ${err}`, "EINVAL");
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_JUPYTER_IPYNB_RPC_BYTES) {
    throw codedError(
      `ipynb is too large (${bytes} bytes; max ${MAX_JUPYTER_IPYNB_RPC_BYTES})`,
      "E2BIG",
    );
  }
  return serialized;
}

function validateIpynbPath(path: string): void {
  const normalizedSeparators =
    typeof path === "string" ? path.replace(/\\/g, "/") : "";
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path) > MAX_JUPYTER_PATH_BYTES ||
    /[\x00-\x1f\x7f]/.test(path) ||
    normalizedSeparators.split("/").includes("..") ||
    !path.toLowerCase().endsWith(".ipynb")
  ) {
    throw codedError("path must name a valid .ipynb file", "EINVAL");
  }
}

function hasNativeAttachments(ipynb: any): boolean {
  return (ipynb?.cells ?? []).some((cell: any) => {
    if (cell?.cell_type !== "markdown") return false;
    if (
      cell.attachments != null &&
      typeof cell.attachments === "object" &&
      Object.keys(cell.attachments).length > 0
    ) {
      return true;
    }
    const source = Array.isArray(cell.source)
      ? cell.source.join("")
      : `${cell.source ?? ""}`;
    return /attachment:[^\s"'<>()[\]]+/i.test(source);
  });
}

async function acquireGlobalSlot(): Promise<() => void> {
  if (globalActive >= MAX_CONCURRENT_GLOBAL) {
    await new Promise<void>((resolve) => globalWaiters.push(resolve));
  }
  globalActive += 1;
  return () => {
    globalActive -= 1;
    globalWaiters.shift()?.();
  };
}

async function withNotebookAdmission<T>(
  project_id: string,
  bytes: number,
  task: () => Promise<T>,
): Promise<T> {
  const pending = projectPending.get(project_id) ?? 0;
  const pendingBytes = projectPendingBytes.get(project_id) ?? 0;
  if (
    pending >= MAX_PENDING_PER_PROJECT ||
    globalPending >= MAX_PENDING_GLOBAL ||
    pendingBytes + bytes > MAX_PENDING_BYTES_PER_PROJECT ||
    globalPendingBytes + bytes > MAX_PENDING_BYTES_GLOBAL
  ) {
    throw codedError("too many pending notebook conversion requests", "EBUSY");
  }
  projectPending.set(project_id, pending + 1);
  projectPendingBytes.set(project_id, pendingBytes + bytes);
  globalPending += 1;
  globalPendingBytes += bytes;

  const previous = projectTails.get(project_id) ?? Promise.resolve();
  let finishTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    finishTail = resolve;
  });
  const queuedTail = previous.catch(() => {}).then(() => tail);
  projectTails.set(project_id, queuedTail);

  try {
    await previous.catch(() => {});
    const releaseGlobal = await acquireGlobalSlot();
    try {
      return await task();
    } finally {
      releaseGlobal();
    }
  } finally {
    finishTail();
    globalPending -= 1;
    globalPendingBytes -= bytes;
    const remaining = (projectPending.get(project_id) ?? 1) - 1;
    const remainingBytes =
      (projectPendingBytes.get(project_id) ?? bytes) - bytes;
    if (remaining <= 0) {
      projectPending.delete(project_id);
      projectPendingBytes.delete(project_id);
      if (projectTails.get(project_id) === queuedTail) {
        projectTails.delete(project_id);
      }
    } else {
      projectPending.set(project_id, remaining);
      projectPendingBytes.set(project_id, Math.max(0, remainingBytes));
    }
  }
}

async function importIpynb(
  project_id: string,
  ipynb: object,
  blobStore: JupyterFilesystemBlobStore,
  validated = false,
): Promise<JupyterImportIpynbResult> {
  if (!validated) {
    validateIpynb(ipynb);
  }
  const liveIpynb = hasNativeAttachments(ipynb)
    ? await externalizeJupyterAttachments({
        ipynb,
        loadBlob: async (uuid) =>
          await blobStore.loadBlob({ project_id, uuid }),
        saveBlob: async (opts) =>
          await blobStore.saveBlob({ project_id, ...opts }),
      })
    : ipynb;
  validateIpynb(liveIpynb);
  return { ipynb: liveIpynb };
}

async function readPreviousIpynb(
  fs: Filesystem,
  path: string,
): Promise<any | undefined> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_JUPYTER_IPYNB_RPC_BYTES) return;
    const raw = await fs.readFile(path);
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : `${raw}`;
    if (Buffer.byteLength(text) > MAX_JUPYTER_IPYNB_RPC_BYTES) return;
    return JSON.parse(text);
  } catch {
    return;
  }
}

export async function importJupyterIpynb({
  project_id,
  ipynb,
  blobStore,
}: {
  project_id: string;
  ipynb: object;
  blobStore: JupyterFilesystemBlobStore;
}): Promise<JupyterImportIpynbResult> {
  const bytes = Buffer.byteLength(validateIpynb(ipynb));
  return await withNotebookAdmission(
    project_id,
    bytes,
    async () => await importIpynb(project_id, ipynb, blobStore, true),
  );
}

export async function saveJupyterIpynb({
  project_id,
  path,
  ipynb,
  fs,
  blobStore,
}: {
  project_id: string;
  path: string;
  ipynb: object;
  fs: Filesystem;
  blobStore: JupyterFilesystemBlobStore;
}): Promise<JupyterSaveIpynbResult> {
  validateIpynbPath(path);
  const input = validateIpynb(ipynb);
  const inputBytes = Buffer.byteLength(input);
  return await withNotebookAdmission(project_id, inputBytes, async () => {
    const { ipynb: liveIpynb } = await importIpynb(
      project_id,
      ipynb,
      blobStore,
      true,
    );
    const previousIpynb = await readPreviousIpynb(fs, path);
    const portableIpynb = await embedCoCalcBlobImages({
      ipynb: liveIpynb,
      previousIpynb,
      loadBlob: async (uuid) => await blobStore.loadBlob({ project_id, uuid }),
    });
    const serialized = JSON.stringify(portableIpynb, undefined, 2);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_JUPYTER_IPYNB_RPC_BYTES) {
      throw codedError(
        `portable ipynb is too large (${bytes} bytes; max ${MAX_JUPYTER_IPYNB_RPC_BYTES})`,
        "E2BIG",
      );
    }
    await fs.writeFile(path, serialized, true);
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await fs.stat(path))?.mtimeMs;
    } catch {
      // The sha1 alone still identifies the save.
    }
    const live = validateIpynb(liveIpynb);
    logger.debug("saved portable notebook", { project_id, path, bytes });
    return {
      ipynb: liveIpynb,
      bytes,
      converted: live !== input,
      sha1: sha1(serialized),
      mtimeMs,
    };
  });
}
