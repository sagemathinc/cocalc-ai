/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { extractArtifactCatalog } from "@cocalc/chat";
import { ArtifactCatalogService } from "@cocalc/backend/artifacts/service";
import {
  journalArtifactFilesystem,
  readArtifactSource,
} from "@cocalc/backend/artifacts/filesystem";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { data } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import type { ArtifactCatalogApi } from "@cocalc/conat/hub/api/artifact-catalog";
import { getMasterConatClient } from "./master-conat-client";
import { getLocalHostId } from "./sqlite/hosts";
import { listProjects } from "./sqlite/projects";

const logger = getLogger("project-host:artifact-catalog");
let service: ArtifactCatalogService | undefined;

async function call<K extends keyof ArtifactCatalogApi>(
  name: K,
  opts: Parameters<ArtifactCatalogApi[K]>[0],
): Promise<Awaited<ReturnType<ArtifactCatalogApi[K]>>> {
  const client = getMasterConatClient(),
    host_id = getLocalHostId();
  if (!client || !host_id) throw Error("catalog owner connection unavailable");
  const result = await callHub({
    client,
    host_id,
    name: `artifactCatalog.${name}`,
    args: [opts],
  });
  if (result?.error) throw Error(`${result.error}`);
  return result;
}

export function startArtifactCatalog(
  getFilesystem: (project_id: string) => Promise<SandboxedFilesystem>,
) {
  if (service) return service;
  const directory = join(data, "artifact-catalog");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let afterProject = "";
  let currentProject: string | undefined;
  let after: string | undefined;
  let completedRound = false;
  let nextRoundAt = 0;
  service = new ArtifactCatalogService({
    filename: join(directory, "journal.sqlite"),
    discoveryIntervalMs: 2000,
    writerState: (source) => call("writerState", source),
    register: (request) => call("registerSource", request),
    send: async (snapshot) => {
      await call("ingest", { ...snapshot, snapshot });
    },
    read: async (source) => {
      const fs = await getFilesystem(source.project_id);
      try {
        return extractArtifactCatalog(
          await readArtifactSource(fs, source.chat_path),
        );
      } finally {
        fs.close();
      }
    },
    discover: async () => {
      if (Date.now() < nextRoundAt) return [];
      if (completedRound) {
        completedRound = false;
        afterProject = "";
        nextRoundAt = Date.now() + 30_000;
        return [];
      }
      if (!currentProject) {
        const projects = listProjects()
          .filter((p) => !p.local_only)
          .map((p) => p.project_id)
          .sort();
        currentProject = projects.find((id) => id > afterProject);
        if (!currentProject) {
          afterProject = "";
          nextRoundAt = Date.now() + 30_000;
          return [];
        }
        if (!currentProject) return [];
      }
      const project_id = currentProject;
      try {
        const page = await call("sourcePage", { project_id, after });
        after = page.next;
        if (!after) {
          afterProject = project_id;
          currentProject = undefined;
          completedRound = !listProjects().some(
            (p) => !p.local_only && p.project_id > project_id,
          );
        }
        return page.paths.map((chat_path) => ({ project_id, chat_path }));
      } catch (err) {
        afterProject = project_id;
        currentProject = undefined;
        after = undefined;
        throw err;
      }
    },
    onError: (source, err) =>
      logger.warn("catalog indexing deferred", { source, error: `${err}` }),
  });
  service.start();
  return service;
}

export function withArtifactCatalog(
  fs: SandboxedFilesystem,
  project_id: string,
) {
  return service
    ? journalArtifactFilesystem(fs, project_id, service.journal)
    : fs;
}
