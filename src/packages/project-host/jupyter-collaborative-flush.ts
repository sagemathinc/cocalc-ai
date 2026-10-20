/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@cocalc/conat/core/client";
import type { CollaborativeNotebookSourceVersion } from "@cocalc/conat/files/file-server";
import {
  fsClient,
  fsSubject,
  type FilesystemClient,
} from "@cocalc/conat/files/fs";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import { syncdbIsGeneratedPlaceholder } from "@cocalc/jupyter/ipynb/placeholder";
import { SYNCDB_OPTIONS } from "@cocalc/jupyter/redux/sync";
import { SyncDB } from "@cocalc/sync/editor/db";
import type { DBDocument } from "@cocalc/sync/editor/db/doc";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { saveJupyterIpynb } from "./jupyter-ipynb";
import { jupyterNotebookContents } from "./jupyter-notebook-contents";

const DEFAULT_MAX_NOTEBOOKS = 500;
const MAX_SCANNED_ENTRIES = 20_000;
const MAX_SAVE_ATTEMPTS = 3;
const STABILITY_DELAY_MS = 75;

function normalizeSourcePath(raw: string): string {
  const normalized = path.posix.normalize(`${raw ?? ""}`.trim());
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`invalid collaborative flush path: ${raw}`);
  }
  return normalized === "." ? "" : normalized;
}

function isNotebookPath(value: string): boolean {
  return (
    value.endsWith(".ipynb") && !value.split("/").includes(".ipynb_checkpoints")
  );
}

export async function findJupyterNotebooks({
  filesystem,
  paths,
  max_notebooks = DEFAULT_MAX_NOTEBOOKS,
}: {
  filesystem: FilesystemClient;
  paths: string[];
  max_notebooks?: number;
}): Promise<string[]> {
  const limit = Math.max(1, Math.floor(max_notebooks));
  const pending = Array.from(new Set(paths.map(normalizeSourcePath))).reverse();
  const notebooks = new Set<string>();
  let scanned = 0;
  while (pending.length) {
    const current = pending.pop()!;
    scanned += 1;
    if (scanned > MAX_SCANNED_ENTRIES) {
      throw new Error(
        `collaborative notebook scan exceeded ${MAX_SCANNED_ENTRIES} entries`,
      );
    }
    const info = await filesystem.lstat(current);
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) {
      if (isNotebookPath(current)) {
        notebooks.add(current);
        if (notebooks.size > limit) {
          throw new Error(
            `collection contains more than ${limit} Jupyter notebooks`,
          );
        }
      }
      continue;
    }
    if (!info.isDirectory()) continue;
    const entries = (await filesystem.readdir(current, {
      withFileTypes: true,
    })) as unknown as Array<{ name: string }>;
    for (const entry of entries) {
      if (entry.name === ".ipynb_checkpoints") continue;
      pending.push(path.posix.join(current, entry.name));
    }
  }
  return Array.from(notebooks).sort();
}

async function readNotebookMetadata(
  filesystem: FilesystemClient,
  notebookPath: string,
): Promise<any> {
  const value = await filesystem.readFile(notebookPath, "utf8");
  try {
    return JSON.parse(
      typeof value === "string" ? value : Buffer.from(value).toString("utf8"),
    );
  } catch {
    return {};
  }
}

export async function flushJupyterNotebook({
  project_id,
  notebook_path,
  actor_account_id,
  filesystem,
  syncClient,
}: {
  project_id: string;
  notebook_path: string;
  actor_account_id: string;
  filesystem: FilesystemClient;
  syncClient: SyncClient;
}): Promise<CollaborativeNotebookSourceVersion | undefined> {
  // Filesystem scans return paths relative to the project volume, while sync
  // documents use the canonical path visible inside the project runtime.
  const sync_path = syncdbPath(
    path.posix.join(DEFAULT_PROJECT_RUNTIME_HOME, notebook_path),
  );
  const doc = new SyncDB({
    project_id,
    client: syncClient,
    fs: filesystem,
    noBackendFsWatch: true,
    trustedAccountId: actor_account_id,
    ...SYNCDB_OPTIONS,
    cursors: false,
    path: sync_path,
  });
  try {
    await doc.wait_until_ready();
    if (doc.newestVersion() == null) {
      return;
    }
    const requestedNotebook = await readNotebookMetadata(
      filesystem,
      notebook_path,
    );
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
      await delay(STABILITY_DELAY_MS);
      const version = doc.newestVersion();
      if (version == null) return;
      // The live notebook may be only the generated empty cell (it was
      // opened while the file was still empty, e.g. during a course copy).
      // It carries no work and is never written: a write could replace a
      // file the copy is still filling in, whatever the file looked like a
      // moment earlier. The file as it is is recorded as this version,
      // unless the notebook is edited meanwhile (support ticket 21023).
      const placeholder = syncdbIsGeneratedPlaceholder(doc);
      if (!placeholder) {
        const contents = jupyterNotebookContents(
          doc.get_doc() as DBDocument,
          requestedNotebook,
        );
        await saveJupyterIpynb({
          project_id,
          path: notebook_path,
          ipynb: JSON.parse(contents),
          fs: filesystem,
        });
        if (doc.newestVersion() !== version) {
          continue;
        }
      }
      let saved: Buffer | string;
      try {
        saved = await filesystem.readFile(notebook_path);
      } catch (err: any) {
        if (!placeholder || err?.code !== "ENOENT") throw err;
        if (doc.newestVersion() !== version) continue;
        // No file and nothing to write: there is nothing to collect.
        return;
      }
      const bytes = Buffer.isBuffer(saved)
        ? saved
        : Buffer.from(saved as string, "utf8");
      if (doc.newestVersion() !== version) {
        continue;
      }
      return {
        path: notebook_path,
        sync_path,
        version,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        saved_at: new Date().toISOString(),
      };
    }
    throw new Error(
      `Jupyter notebook kept changing while being collected: ${notebook_path}`,
    );
  } finally {
    await doc.close();
  }
}

export async function flushJupyterNotebooksToDisk({
  client,
  project_id,
  paths,
  actor_account_id,
  max_notebooks,
}: {
  client: Client;
  project_id: string;
  paths: string[];
  actor_account_id: string;
  max_notebooks?: number;
}): Promise<{ notebooks: CollaborativeNotebookSourceVersion[] }> {
  const filesystem = fsClient({
    client,
    subject: fsSubject({ project_id }),
  });
  const notebookPaths = await findJupyterNotebooks({
    filesystem,
    paths,
    max_notebooks,
  });
  const syncClient = new SyncClient(client);
  try {
    const notebooks: CollaborativeNotebookSourceVersion[] = [];
    for (const notebook_path of notebookPaths) {
      const result = await flushJupyterNotebook({
        project_id,
        notebook_path,
        actor_account_id,
        filesystem,
        syncClient,
      });
      if (result) notebooks.push(result);
    }
    return { notebooks };
  } finally {
    syncClient.close();
  }
}
