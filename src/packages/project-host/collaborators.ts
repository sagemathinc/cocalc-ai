/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { join, posix } from "node:path";
import { mkdirSync } from "node:fs";
import { extractCollaborationMetadata } from "@cocalc/chat";
import { CollaboratorsService } from "@cocalc/backend/collaborators/service";
import type { CollaborationSource } from "@cocalc/backend/collaborators/journal";
import {
  journalCollaborationFilesystem,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { data } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { getMasterConatClient } from "./master-conat-client";
import { getLocalHostId } from "./sqlite/hosts";
import { getProject, listProjects } from "./sqlite/projects";
import { initializeCopiedCollaboration } from "./collaborators-copy";
import { flushHostedCanonicalRoom } from "./collaborators-flush";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

const logger = getLogger("project-host:collaborators");
let service: CollaboratorsService | undefined;
let filesystem:
  | ((project_id: string) => Promise<SandboxedFilesystem>)
  | undefined;
function assertLocal(project_id: string) {
  const project = getProject(project_id);
  if (!project || project.local_only)
    throw Error("collaboration project is not available locally");
}

/** Artifact metadata must not populate a move destination before owner CAS. */
export async function assertArtifactCollaborationSourceReady(
  source: CollaborationSource,
): Promise<void> {
  const current = service;
  if (!current || !(await current.journal.isEnabled())) return;
  current.journal.assertSourceReady(source);
}
async function request(project_id: string, name: string, opts: unknown) {
  assertLocal(project_id);
  const client = getMasterConatClient(),
    host_id = getLocalHostId();
  if (!client || !host_id)
    throw Error("collaboration owner connection unavailable");
  const result = await callHub({ client, host_id, name, args: [opts] });
  if (result?.error) throw Error(`${result.error}`);
  return result;
}

export function startCollaborators(
  getFilesystem: (project_id: string) => Promise<SandboxedFilesystem>,
) {
  if (service) return service;
  filesystem = getFilesystem;
  const directory = join(data, "collaborators");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let afterProject = "",
    after: string | undefined,
    currentProject: string | undefined;
  let inventory: "collaborators" | "artifactCatalog" = "collaborators";
  let localAfter = "",
    localRound = false,
    nextRoundAt = 0;
  let enabled = false,
    refreshEnabledAt = 0;
  service = new CollaboratorsService({
    filename: join(directory, "journal.sqlite"),
    beforeRead: (source) =>
      flushHostedCanonicalRoom(source, {
        journal: service!.journal,
        getFilesystem,
        writerState: (source) =>
          request(source.project_id, "collaborators.writerState", source),
      }),
    initializeCopy: (copy) =>
      initializeCopiedCollaboration(copy, getFilesystem),
    sourceActivity: async ({ project_id, chat_path, epoch, after }) => {
      const page = await request(project_id, "collaborators.checkpointPage", {
        project_id,
        chat_path,
        ...(after ? { after } : {}),
      });
      if (
        !page ||
        page.epoch !== epoch ||
        !Array.isArray(page.items) ||
        page.items.length > 50
      )
        throw Error("invalid epoch-fenced collaboration checkpoint page");
      return {
        epoch: page.epoch,
        resources: page.items,
        ...(page.next ? { next: page.next } : {}),
      };
    },
    relocate: (opts) =>
      request(opts.project_id, "collaborators.relocateSource", opts),
    enabled: async () => {
      if (Date.now() < refreshEnabledAt) return enabled;
      enabled = false;
      refreshEnabledAt = Date.now() + 30_000;
      const client = getMasterConatClient(),
        host_id = getLocalHostId();
      if (!client || !host_id) return false;
      const result = await callHub({
        client,
        host_id,
        name: "system.getCustomize",
        args: [["collaborators_enabled"]],
      });
      if (result?.error) throw Error(`${result.error}`);
      enabled = result?.collaborators_enabled === true;
      return enabled;
    },
    writerState: (source) =>
      request(source.project_id, "collaborators.writerState", source),
    recoverWriter: async (source, expectedEpoch) => {
      const current = await request(
        source.project_id,
        "collaborators.writerState",
        source,
      );
      if (
        (current?.epoch ?? null) === expectedEpoch ||
        (current && current.writer_host_id === getLocalHostId())
      )
        return undefined;
      return { epoch: current?.epoch ?? null };
    },
    register: (opts) =>
      request(
        opts.project_id,
        "collaborators.registerSource",
        opts,
      ) as ReturnType<CollaboratorsApi["registerSource"]>,
    send: (snapshot) =>
      request(snapshot.project_id, "collaborators.ingest", {
        snapshot,
      }) as ReturnType<CollaboratorsApi["ingest"]>,
    read: (source) =>
      withProjectVolumeLifecycleLock(source.project_id, async () => {
        assertLocal(source.project_id);
        const generation = currentProjectVolumeLifecycleGeneration(
          source.project_id,
        );
        const fs = await getFilesystem(source.project_id);
        try {
          const rows = await readCollaborationSource(fs, source.chat_path);
          assertProjectVolumeLifecycleGeneration(source.project_id, generation);
          assertLocal(source.project_id);
          return {
            // This is only a marked-room candidate. The owning bay must confirm
            // the current canonical locator before accepting notification facts.
            ...extractCollaborationMetadata(rows, source, {
              humanRoomPath: source.chat_path,
            }),
            lifecycle_generation: generation,
          };
        } finally {
          fs.close();
        }
      }),
    discover: async (): Promise<CollaborationSource[]> => {
      if (Date.now() < nextRoundAt) return [];
      if (localRound) {
        const page = service!.journal.sources(localAfter);
        localAfter = page.length
          ? `${page[page.length - 1].project_id}:${page[page.length - 1].chat_path}`
          : "";
        if (!localAfter) {
          localRound = false;
          nextRoundAt = Date.now() + 30_000;
        }
        return page.filter(({ project_id }) => {
          const p = getProject(project_id);
          return p && !p.local_only;
        });
      }
      if (!currentProject) {
        currentProject = listProjects()
          .filter((p) => !p.local_only)
          .map((p) => p.project_id)
          .sort()
          .find((id) => id > afterProject);
        if (!currentProject) {
          afterProject = "";
          localRound = true;
          return [];
        }
      }
      const project_id = currentProject;
      try {
        // Existing inventory is chat-source based, including unnamed agents.
        const page = await request(project_id, `${inventory}.sourcePage`, {
          project_id,
          after,
        });
        if (!Array.isArray(page.paths) || page.paths.length > 100)
          throw Error("invalid source inventory page");
        after = page.next;
        if (!after) {
          if (inventory === "collaborators") inventory = "artifactCatalog";
          else {
            inventory = "collaborators";
            afterProject = project_id;
            currentProject = undefined;
          }
        }
        return page.paths.map((chat_path: string) => ({
          project_id,
          chat_path,
        }));
      } catch (err) {
        afterProject = project_id;
        currentProject = undefined;
        after = undefined;
        inventory = "collaborators";
        throw err;
      }
    },
    onError: (source, err) =>
      logger.warn("collaboration indexing deferred", {
        source,
        error: `${err}`,
      }),
  });
  service.start();
  return service;
}

export function withCollaborators(fs: SandboxedFilesystem, project_id: string) {
  return service
    ? journalCollaborationFilesystem(fs, project_id, service.journal)
    : fs;
}

export function getCollaboratorsService(): CollaboratorsService {
  if (!service) throw Error("collaborators service is not started");
  return service;
}

/** First creation needs the parent before SyncDB saves its temporary sibling. */
export async function ensureUninitializedRoomParent(room: CollaborationRoom) {
  if (!filesystem) throw Error("collaborators service is not started");
  await withProjectVolumeLifecycleLock(room.project_id, async () => {
    assertLocal(room.project_id);
    const generation = currentProjectVolumeLifecycleGeneration(room.project_id);
    const fs = await filesystem!(room.project_id);
    try {
      await fs.mkdir(posix.dirname(room.chat_path), { recursive: true });
      assertProjectVolumeLifecycleGeneration(room.project_id, generation);
      assertLocal(room.project_id);
    } finally {
      fs.close();
    }
  });
}

/** Do not let opening a cached live SyncDB resurrect a deleted canonical room. */
export async function assertInitializedRoomSource(room: CollaborationRoom) {
  if (!filesystem) throw Error("collaborators service is not started");
  await withProjectVolumeLifecycleLock(room.project_id, async () => {
    assertLocal(room.project_id);
    const generation = currentProjectVolumeLifecycleGeneration(room.project_id);
    const fs = await filesystem!(room.project_id);
    try {
      const rows = await readCollaborationSource(fs, room.chat_path);
      assertProjectVolumeLifecycleGeneration(room.project_id, generation);
      const markers = rows.filter(
        (row: any) => row?.event === "collaborators-room",
      ) as any[];
      if (
        markers.length !== 1 ||
        markers[0].room_id !== room.room_id ||
        markers[0].project_id !== room.project_id
      )
        throw Error(
          "human room was deleted or replaced; explicit restore required",
        );
    } finally {
      fs.close();
    }
  });
}

export async function stopCollaborators() {
  const current = service;
  if (!current) return;
  await current.close();
  if (service === current) {
    service = undefined;
    filesystem = undefined;
  }
}
