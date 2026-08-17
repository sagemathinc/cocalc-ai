/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";

const SHA1 = /^[0-9a-f]{40}$/i;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export interface NotebookBlobResolver {
  close: () => void;
  resolve: (key: string) => Promise<Uint8Array>;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("The notebook output blob has an unsupported encoding.");
}

export function notebookBlobStoreName(path: string): string {
  return `jupyter/${path.replace(/^\/+/, "")}`;
}

export function isNotebookBlobReference(value: string): boolean {
  return SHA1.test(value.trim());
}

export function createNotebookBlobResolver({
  client,
  path,
  projectId,
}: {
  client: Client;
  path: string;
  projectId: string;
}): NotebookBlobResolver {
  const store = client.sync.akv<unknown>({
    name: notebookBlobStoreName(path),
    project_id: projectId,
  });
  return {
    close: () => store.close(),
    async resolve(key) {
      const normalized = key.trim();
      if (!isNotebookBlobReference(normalized)) {
        throw new Error("The notebook output reference is invalid.");
      }
      const value = await store.get(normalized, { timeout: 30_000 });
      if (value == null) throw new Error("The notebook output is unavailable.");
      const bytes = asBytes(value);
      if (bytes.byteLength > MAX_BLOB_BYTES) {
        throw new Error(
          "The notebook output exceeds the Essential size limit.",
        );
      }
      return bytes;
    },
  };
}
