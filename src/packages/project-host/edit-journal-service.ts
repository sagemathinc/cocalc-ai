/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import {
  fsClient,
  fsSubject,
  type FilesystemClient,
} from "@cocalc/conat/files/fs";
import {
  parseEditJournalSubject,
  type EditJournalBatch,
  type EditJournalSaveResponse,
  type NotebookJournalSaveRequest,
  type TextJournalSaveRequest,
} from "@cocalc/conat/project/edit-journal";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import { export_to_ipynb } from "@cocalc/jupyter/ipynb/export-to-ipynb";
import { IPynbImporter } from "@cocalc/jupyter/ipynb/import-from-ipynb";
import { SYNCDB_OPTIONS } from "@cocalc/jupyter/redux/sync";
import { SyncDB } from "@cocalc/sync/editor/db";
import type { DBDocument, DbPatch } from "@cocalc/sync/editor/db/doc";
import { SyncString } from "@cocalc/sync/editor/string/sync";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { syncdbPath } from "@cocalc/util/jupyter/names";

const logger = getLogger("project-host:edit-journal");

export const PROJECT_EDIT_JOURNAL_SUBJECT = "services.*.*.*.*.edit-journal";

const MAX_TEXT_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_NOTEBOOK_BYTES = 16 * 1024 * 1024;
const MAX_NOTEBOOK_PATCH_BYTES = 8 * 1024 * 1024;
const DOCUMENT_TTL_MS = 10 * 60_000;

type JournalDocument = SyncString | SyncDB;

interface CachedDocument {
  doc: JournalDocument;
  filesystem: FilesystemClient;
}

interface ServiceContext {
  subject?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asText(value: string | Uint8Array): string {
  return typeof value === "string"
    ? value
    : Buffer.from(value).toString("utf8");
}

function requirePath(path: string): string {
  const value = `${path ?? ""}`.trim();
  if (!value || value.includes("\0")) {
    throw new Error("path must be a nonempty filesystem path");
  }
  return value;
}

function requireBatch(batch: EditJournalBatch): void {
  if (!batch.journal_id || batch.journal_id.length > 200) {
    throw new Error("journal_id must be a nonempty bounded string");
  }
  if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0) {
    throw new Error("sequence must be a nonnegative safe integer");
  }
}

function requireSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("base_sha256 must be a lowercase SHA-256 digest");
  }
}

function assertPatchSize(patch: unknown, limit = MAX_TEXT_PATCH_BYTES): void {
  if (Buffer.byteLength(JSON.stringify(patch), "utf8") > limit) {
    throw new Error("edit journal patch is too large");
  }
}

function assertCollaborator({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): void {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  if (!isProjectCollaboratorGroup(group)) {
    throw new Error(
      `account '${account_id}' is not a collaborator on project '${project_id}'`,
    );
  }
}

function journalMeta(batch: EditJournalBatch) {
  return {
    essential_edit_journal: {
      journal_id: batch.journal_id,
      sequence: batch.sequence,
    },
  };
}

function immutableValue(value: any): any {
  return value?.toJS instanceof Function ? value.toJS() : value;
}

function notebookTarget(current: DBDocument, notebook: any): DBDocument {
  const importer = new IPynbImporter();
  importer.import({ ipynb: JSON.parse(JSON.stringify(notebook)) });
  let target = current.delete({ type: "cell" });
  for (const cell of Object.values(importer.cells())) {
    target = target.set(cell);
  }
  const currentSettings = immutableValue(current.get_one({ type: "settings" }));
  target = target.set({
    type: "settings",
    kernel: importer.kernel() ?? null,
    metadata: importer.metadata() ?? null,
    trust: currentSettings?.trust,
  });
  importer.close();
  return target;
}

function notebookPatch(
  current: DBDocument,
  request: NotebookJournalSaveRequest,
  baseNotebook: any,
  notebook: any,
): DbPatch {
  const sourceUpdates = request.cell_patches.map(({ cell_id, patch }) => ({
    type: "cell",
    id: cell_id,
    input: patch,
  }));
  const sourcePatch: DbPatch = sourceUpdates.length ? [1, sourceUpdates] : [];
  const base = notebookTarget(current, baseNotebook);
  const withSources = base.apply_patch(sourcePatch);
  const target = notebookTarget(withSources, notebook);
  return [...sourcePatch, ...withSources.make_patch(target)] as DbPatch;
}

function notebookContents(doc: DBDocument, requestedNotebook: any): string {
  const cells: Record<string, any> = {};
  const cellList: Array<{ id: string; pos: number }> = [];
  doc.get({ type: "cell" })?.forEach((value: any) => {
    const cell = immutableValue(value);
    const id = `${cell?.id ?? ""}`;
    if (!id) return;
    cells[id] = cell;
    cellList.push({
      id,
      pos: Number.isFinite(cell.pos) ? cell.pos : Number.MAX_SAFE_INTEGER,
    });
  });
  cellList.sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id));
  const settings =
    immutableValue(doc.get_one({ type: "settings" })) ?? ({} as any);
  const metadata = structuredClone(settings.metadata ?? {});
  const requestedKernel = requestedNotebook?.metadata?.kernelspec;
  const kernelName = `${settings.kernel ?? requestedKernel?.name ?? ""}`;
  const kernelspec =
    requestedKernel?.name?.toLowerCase() === kernelName.toLowerCase()
      ? structuredClone(requestedKernel)
      : kernelName
        ? { name: kernelName, display_name: kernelName }
        : {};
  const ipynb = export_to_ipynb({
    cells: structuredClone(cells),
    cell_list: cellList.map(({ id }) => id),
    metadata,
    kernelspec,
    language_info: metadata.language_info,
  });
  return `${JSON.stringify(ipynb, null, 1)}\n`;
}

export const __test__ = { notebookContents, notebookPatch, sha256 };

export async function initProjectEditJournalService(client: Client) {
  const syncClient = new SyncClient(client);
  const documents = new TTL<string, CachedDocument>({
    ttl: DOCUMENT_TTL_MS,
    max: 256,
    dispose: ({ doc }) => {
      void doc.close();
    },
  });
  const opening = new Map<string, Promise<CachedDocument>>();
  const queues = new Map<string, Promise<void>>();

  const withDocumentLock = async <T>(key: string, fn: () => Promise<T>) => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    queues.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (queues.get(key) === queued) queues.delete(key);
    }
  };

  const openDocument = async ({
    account_id,
    project_id,
    path,
    kind,
  }: {
    account_id: string;
    project_id: string;
    path: string;
    kind: "text" | "notebook";
  }): Promise<CachedDocument> => {
    const key = `${account_id}:${project_id}:${kind}:${path}`;
    const cached = documents.get(key);
    if (cached && !cached.doc.isClosed()) return cached;
    const pending = opening.get(key);
    if (pending) return await pending;
    const promise = (async () => {
      const filesystem = fsClient({
        client,
        subject: fsSubject({ project_id }),
      });
      const common = {
        project_id,
        client: syncClient,
        fs: filesystem,
        persistent: true,
        noBackendFsWatch: true,
        trustedAccountId: account_id,
      } as const;
      const doc: JournalDocument =
        kind === "text"
          ? new SyncString({ ...common, path })
          : new SyncDB({
              ...common,
              ...SYNCDB_OPTIONS,
              cursors: false,
              path: syncdbPath(path),
            });
      await doc.wait_until_ready();
      await doc.reconcileTrustedDisk();
      const opened = { doc, filesystem };
      documents.set(key, opened);
      opening.delete(key);
      return opened;
    })().catch((err) => {
      opening.delete(key);
      throw err;
    });
    opening.set(key, promise);
    return await promise;
  };

  const identity = (context: ServiceContext) => {
    const value = parseEditJournalSubject(context.subject);
    assertCollaborator(value);
    return value;
  };

  const saveText = async function (
    this: ServiceContext,
    request: TextJournalSaveRequest,
  ): Promise<EditJournalSaveResponse> {
    requireBatch(request);
    requireSha256(request.base_sha256);
    const path = requirePath(request.path);
    assertPatchSize(request.patch);
    const ids = identity(this);
    const lockKey = `${ids.project_id}:${path}`;
    return await withDocumentLock(lockKey, async () => {
      const { doc, filesystem } = await openDocument({
        ...ids,
        path,
        kind: "text",
      });
      const sync = doc as SyncString;
      const disk = asText(await filesystem.readFile(path, "utf8"));
      const duplicate = sync.hasEditJournalCommit({
        journalId: request.journal_id,
        sequence: request.sequence,
      });
      if (!duplicate && sha256(disk) !== request.base_sha256) {
        throw Object.assign(new Error("file changed on the server"), {
          code: "ETAG_MISMATCH",
        });
      }
      const env = duplicate
        ? undefined
        : await sync.commitExactPatch(request.patch, {
            meta: journalMeta(request),
          });
      const contents = sync.to_str();
      if (
        duplicate &&
        sha256(disk) !== request.base_sha256 &&
        disk !== contents
      ) {
        throw Object.assign(
          new Error("file changed after the journal commit"),
          { code: "ETAG_MISMATCH" },
        );
      }
      if (disk !== contents) {
        await filesystem.writeFileIfUnchanged(path, contents, disk, true);
      }
      return {
        committed: env != null,
        contents,
        sha256: sha256(contents),
        time: env?.time,
      };
    });
  };

  const saveNotebook = async function (
    this: ServiceContext,
    request: NotebookJournalSaveRequest,
  ): Promise<EditJournalSaveResponse> {
    requireBatch(request);
    requireSha256(request.base_sha256);
    const path = requirePath(request.path);
    if (!path.endsWith(".ipynb")) {
      throw new Error("notebook edit journal paths must end with .ipynb");
    }
    if (Buffer.byteLength(request.contents, "utf8") > MAX_NOTEBOOK_BYTES) {
      throw new Error("notebook is too large for the edit journal");
    }
    assertPatchSize(request.cell_patches, MAX_NOTEBOOK_PATCH_BYTES);
    for (const change of request.cell_patches) {
      if (!change.cell_id) throw new Error("cell_id must be nonempty");
      assertPatchSize(change.patch);
    }
    const notebook = JSON.parse(request.contents);
    const ids = identity(this);
    const lockKey = `${ids.project_id}:${path}`;
    return await withDocumentLock(lockKey, async () => {
      const { doc, filesystem } = await openDocument({
        ...ids,
        path,
        kind: "notebook",
      });
      const sync = doc as SyncDB;
      const disk = asText(await filesystem.readFile(path, "utf8"));
      const duplicate = sync.hasEditJournalCommit({
        journalId: request.journal_id,
        sequence: request.sequence,
      });
      const diskHash = sha256(disk);
      const requestedHash = sha256(request.contents);
      if (
        !duplicate &&
        diskHash !== request.base_sha256 &&
        diskHash !== requestedHash
      ) {
        throw Object.assign(new Error("notebook changed on the server"), {
          code: "ETAG_MISMATCH",
        });
      }
      const patch = notebookPatch(
        sync.get_doc() as DBDocument,
        request,
        JSON.parse(disk),
        notebook,
      );
      const env = duplicate
        ? undefined
        : await sync.commitExactPatch(patch, {
            meta: journalMeta(request),
          });
      const contents = notebookContents(sync.get_doc() as DBDocument, notebook);
      if (duplicate && diskHash !== request.base_sha256 && disk !== contents) {
        throw Object.assign(
          new Error("notebook changed after the journal commit"),
          { code: "ETAG_MISMATCH" },
        );
      }
      if (disk !== contents) {
        await filesystem.writeFileIfUnchanged(path, contents, disk, true);
      }
      return {
        committed: env != null,
        contents,
        sha256: sha256(contents),
        time: env?.time,
      };
    });
  };

  logger.debug("starting project edit journal service", {
    subject: PROJECT_EDIT_JOURNAL_SUBJECT,
  });
  const service = await client.service(PROJECT_EDIT_JOURNAL_SUBJECT, {
    saveText,
    saveNotebook,
  });
  return {
    close: async () => {
      await service.close();
      for (const { doc } of documents.values()) {
        await doc.close();
      }
      documents.clear();
      syncClient.close();
    },
  };
}
