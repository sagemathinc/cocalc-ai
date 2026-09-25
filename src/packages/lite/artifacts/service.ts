/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { ArtifactCatalogService } from "@cocalc/backend/artifacts/service";
import {
  journalArtifactFilesystem,
  readArtifactSource,
} from "@cocalc/backend/artifacts/filesystem";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import getLogger from "@cocalc/backend/logger";
import { extractArtifactCatalog } from "@cocalc/chat";
import { LiteArtifactCatalog, liteArtifactCatalogReadApi } from "./catalog";
import { LiteArtifactDiscovery } from "./discovery";

const logger = getLogger("lite:artifact-catalog");

/** Explicit standalone entrypoint: importing Lite's shared hub API does not start it. */
export function createLiteArtifactCatalog({
  directory,
  path,
  project_id,
  account_id,
}: {
  directory: string;
  path: string;
  project_id: string;
  account_id: string;
}) {
  if (!account_id) throw Error("Lite catalog account is required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const catalog = new LiteArtifactCatalog({
    filename: join(directory, "catalog.sqlite"),
    project_id,
  });
  const reader = new SandboxedFilesystem(path, {
    unsafeMode: true,
    host: project_id,
    rootfs: process.platform === "win32" ? path : "/",
    homeAliases: process.platform === "win32" ? ["/home/user"] : undefined,
  });
  const discovery = new LiteArtifactDiscovery(path, directory);
  const home = process.platform === "win32" ? "/home/user" : path;
  let after = "";
  let discoverFiles = false;
  let service: ArtifactCatalogService;
  try {
    service = new ArtifactCatalogService({
      filename: join(directory, "journal.sqlite"),
      writerState: (source) => catalog.writerState(source),
      register: (request) => catalog.registerSource(request),
      send: async (snapshot) => {
        await catalog.applySnapshot(snapshot);
      },
      read: async (source) =>
        extractArtifactCatalog(
          await readArtifactSource(reader, source.chat_path),
        ),
      discover: async () => {
        // Alternate known sources (including deleted chats and files outside
        // cwd touched through the service) with incremental historical backfill.
        discoverFiles = !discoverFiles;
        if (discoverFiles) {
          const paths = await discovery.page();
          return Promise.all(
            paths.map(async (filename) => ({
              project_id,
              chat_path: posix.resolve(
                home,
                await reader.canonicalSyncIdentityPath(filename),
              ),
            })),
          );
        }
        const sources = service.journal.sources(project_id, after, 100);
        after = sources.length === 100 ? sources[99].chat_path : "";
        return sources;
      },
      onError: (source, error) =>
        logger.warn("catalog indexing deferred", { source, error: `${error}` }),
    });
  } catch (err) {
    reader.close();
    catalog.close();
    throw err;
  }
  const localOnly = async (): Promise<never> => {
    throw Error("Lite artifact catalog writers are service-local only");
  };
  const api = {
    ...liteArtifactCatalogReadApi(catalog, account_id),
    sourcePage: localOnly,
    writerState: localOnly,
    registerSource: localOnly,
    ingest: localOnly,
  };
  return {
    catalog,
    service,
    api,
    wrapFilesystem(fs: SandboxedFilesystem, requestedProject: string) {
      if (requestedProject !== project_id)
        throw Error("project is not available in this Lite catalog");
      return journalArtifactFilesystem(fs, project_id, service.journal, home);
    },
    start: () => service.start(),
    // At process exit, keep the OS lease held until the filesystem stops too.
    stop: () => service.stop(),
    async close() {
      await service.close();
      await discovery.close();
      reader.close();
      catalog.close();
    },
  };
}
