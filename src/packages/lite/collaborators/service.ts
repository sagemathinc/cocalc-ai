/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaboratorsService } from "@cocalc/backend/collaborators/service";
import {
  journalCollaborationFilesystem,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { journalArtifactFilesystem } from "@cocalc/backend/artifacts/filesystem";
import getLogger from "@cocalc/backend/logger";
import { extractCollaborationMetadata } from "@cocalc/chat";
import { LiteCollaborators } from "./index";
import { liteAgentPins } from "./agent-pins";
import { liteArtifactAliasRemover } from "./library-store";
import type { LiteCollaboratorsOptions } from "./index";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import type { Client } from "@cocalc/conat/core/client";
import { initializeLiteCollaborationCopy } from "./copy";
import { attachLegacyAttention } from "./legacy-attention";
import { LiteArtifactRelocation } from "./artifact-relocation";
import type { LiteArtifactRelocationOptions } from "./artifact-relocation";
import { flushLiteCanonicalRoom } from "./flush";

const logger = getLogger("lite:collaborators");

export interface LiteCollaboratorsServiceOptions extends Omit<
  LiteCollaboratorsOptions,
  "filename"
> {
  directory: string;
  path: string;
  /** Same local data-plane client used by the human-room service. */
  client?: Client;
  artifactCatalog?: LiteArtifactRelocationOptions;
  /** Existing LitePersonalLibrary database; needed for its store-only clear-label helper. */
  personalLibraryFilename?: string;
  /** Trusted local index, e.g. artifactCatalog.catalog.sourcePage, never a browser scan. */
  sourcePage: (opts: {
    project_id: string;
    after?: string;
  }) => Promise<{ paths: string[]; next?: string }>;
}

/** Construct only from standalone Lite's main, not the shared Lite hub module. */
export function createLiteCollaborators(
  options: LiteCollaboratorsServiceOptions,
) {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  const home = process.platform === "win32" ? "/home/user" : options.path;
  if (options.artifactCatalog && !options.personalLibraryFilename)
    throw Error(
      "artifact relocation requires the existing personal Library filename",
    );
  let artifactRelocation: LiteArtifactRelocation | undefined;
  let journalReader: DatabaseSync | undefined;
  const store = new LiteCollaborators({
    ...options,
    personalLibrary: options.personalLibrary
      ? () => {
          const api = options.personalLibrary!();
          artifactRelocation?.bindLibrary(api);
          return api;
        }
      : undefined,
    agentPins: options.agentPins ?? liteAgentPins(options.account_id),
    clearArtifactAlias:
      options.clearArtifactAlias ??
      (options.personalLibraryFilename
        ? liteArtifactAliasRemover(options.personalLibraryFilename)
        : undefined),
    room_path:
      options.room_path ?? posix.join(home, ".cocalc/collaborators.chat"),
    filename: join(options.directory, "catalog.sqlite"),
    artifactRelocator:
      options.artifactRelocator ??
      (options.artifactCatalog
        ? {
            relocate: (...args) => {
              if (!artifactRelocation)
                throw Error("artifact relocation is not initialized");
              artifactRelocation.relocate(...args);
            },
          }
        : undefined),
  });
  const createFilesystem = () =>
    new SandboxedFilesystem(options.path, {
      unsafeMode: true,
      host: options.project_id,
      rootfs: process.platform === "win32" ? options.path : "/",
      homeAliases: process.platform === "win32" ? ["/home/user"] : undefined,
    });
  const reader = createFilesystem();
  let after: string | undefined;
  let ownerAfter: string | undefined;
  let ownerRound = false;
  let localAfter = "";
  let localRound = false;
  let nextRound = 0;
  const enabled = async () => (await options.isEnabled()) === true;
  const disabled = Error("Lite collaborators producer is disabled");
  const assertEnabled = async () => {
    if (!(await enabled())) throw disabled;
  };
  let service!: CollaboratorsService;
  try {
    service = new CollaboratorsService({
      filename: join(options.directory, "journal.sqlite"),
      enabled,
      beforeRead: options.client
        ? (source) =>
            flushLiteCanonicalRoom(source, {
              project_id: options.project_id,
              account_id: options.account_id,
              client: options.client!,
              store,
              journal: service.journal,
              createFilesystem: () => {
                const fs = createFilesystem();
                if (options.artifactCatalog)
                  journalArtifactFilesystem(
                    fs,
                    options.project_id,
                    options.artifactCatalog.journal,
                    home,
                  );
                return journalCollaborationFilesystem(
                  fs,
                  options.project_id,
                  service.journal,
                  home,
                );
              },
            })
        : undefined,
      relocate: async (request) => {
        await assertEnabled();
        return store.relocateSource(request);
      },
      sourceActivity: async (source) => {
        await assertEnabled();
        const page = await store.checkpointPage(source);
        return {
          epoch: page.epoch,
          resources: page.items,
          ...(page.next ? { next: page.next } : {}),
        };
      },
      initializeCopy: options.client
        ? async (copy) => {
            const room = await store.registeredRoom({
              account_id: options.account_id,
              project_id: options.project_id,
            });
            if (room?.chat_path === copy.chat_path)
              throw Error(
                "canonical room replacement requires explicit restore",
              );
            await initializeLiteCollaborationCopy(copy, {
              project_id: options.project_id,
              client: options.client!,
              reader,
              assertEnabled,
            });
          }
        : undefined,
      writerState: async (source) => {
        await assertEnabled();
        return store.writerState(source);
      },
      register: async (request) => {
        await assertEnabled();
        return store.registerSource(request);
      },
      send: async (snapshot) => {
        await assertEnabled();
        // A source can have more live threads than fit in one event delivery.
        // Read the bounded durable queue, not just this delivery's first 100 events.
        const floors = journalReader!
          .prepare(
            "SELECT thread_id,min(CAST(json_extract(payload,'$.activity') AS INTEGER))-1 AS activity FROM notification_events WHERE project_id=? AND chat_path=? AND json_extract(payload,'$.actor_account_id')=? GROUP BY thread_id",
          )
          .all(snapshot.project_id, snapshot.chat_path, options.account_id);
        return store.ingest({
          snapshot,
          initialReadFloors: new Map(
            floors.map((row) => [
              row.thread_id as string,
              Number(row.activity),
            ]),
          ),
        });
      },
      read: async (source) => {
        await assertEnabled();
        if (source.project_id !== options.project_id)
          throw Error("foreign Lite collaborators source");
        const room = await store.registeredRoom({
          account_id: options.account_id,
          project_id: options.project_id,
        });
        const rows = await readCollaborationSource(reader, source.chat_path);
        return attachLegacyAttention(
          extractCollaborationMetadata(rows, source, {
            humanRoomPath: room?.chat_path ?? "",
          }),
          rows,
          options.account_id,
        );
      },
      discover: async () => {
        if (!(await enabled())) return [];
        await store.resumeRelocations();
        if (Date.now() < nextRound) return [];
        if (ownerRound) {
          const page = await store.sourcePage({
            project_id: options.project_id,
            after: ownerAfter,
          });
          ownerAfter = page.next;
          if (!ownerAfter) {
            ownerRound = false;
            localRound = true;
          }
          return page.paths.map((chat_path) => ({
            project_id: options.project_id,
            chat_path,
          }));
        }
        if (localRound) {
          const sources = service.journal.sources(localAfter, 100);
          const last = sources[sources.length - 1];
          if (
            sources.some((source) => source.project_id !== options.project_id)
          )
            throw Error("foreign Lite collaborators journal source");
          localAfter = last ? `${last.project_id}:${last.chat_path}` : "";
          if (!last) {
            localRound = false;
            nextRound = Date.now() + 30_000;
          }
          return sources;
        }
        const page = await options.sourcePage({
          project_id: options.project_id,
          after,
        });
        if (!Array.isArray(page.paths) || page.paths.length > 100)
          throw Error("invalid Lite collaborators source index page");
        after = page.next;
        if (!after) ownerRound = true;
        return page.paths.map((chat_path) => ({
          project_id: options.project_id,
          chat_path,
        }));
      },
      onError: (source, error) => {
        if (error === disabled) return;
        store.setCoverage(
          "partial",
          "Some service-indexed sources could not be refreshed. Last valid metadata is retained; historical discovery is incomplete.",
        );
        logger.warn("collaborators indexing deferred", {
          source,
          error: `${error}`,
        });
      },
    });
    journalReader = new DatabaseSync(
      join(options.directory, "journal.sqlite"),
      { readOnly: true },
    );
    if (options.artifactCatalog) {
      artifactRelocation = new LiteArtifactRelocation({
        ...options.artifactCatalog,
        project_id: options.project_id,
        account_id: options.account_id,
        personalLibraryFilename: options.personalLibraryFilename!,
        pending: (chat_path) =>
          store.isRelocating(chat_path) ||
          !!journalReader!
            .prepare(
              "SELECT 1 FROM relocations WHERE project_id=? AND (from_path=? OR to_path=?) LIMIT 1",
            )
            .get(options.project_id, chat_path, chat_path),
      });
    }
  } catch (error) {
    if (service) {
      service.stop();
      void service.close();
    }
    artifactRelocation?.close();
    journalReader?.close();
    reader.close();
    store.close();
    throw error;
  }
  const api = {
    ...store.api,
    requestSource: async (
      request: Parameters<typeof store.requestSource>[0],
    ) => {
      const result = await store.requestSource(request);
      await assertEnabled();
      service.journal.touch({
        project_id: request.project_id,
        chat_path: request.chat_path,
      });
      return result;
    },
    ensureRoom: async (request: Parameters<typeof store.ensureRoom>[0]) => {
      const room = await store.ensureRoom(request);
      await assertEnabled();
      service.journal.touch({
        project_id: room.project_id,
        chat_path: room.chat_path,
      });
      return room;
    },
  };
  return {
    store,
    service,
    api,
    async ensureRoomDirectory(room: CollaborationRoom): Promise<void> {
      const current = await store.registeredRoom({
        account_id: options.account_id,
        project_id: room.project_id,
      });
      if (
        !current ||
        current.room_id !== room.room_id ||
        current.chat_path !== room.chat_path
      )
        throw Error("canonical room registration changed");
      if (
        current.initialized ||
        service.journal.roomState(room.project_id, room.room_id)
      )
        throw Error("initialized room requires explicit restore");
      await reader.mkdir(posix.dirname(room.chat_path), { recursive: true });
    },
    async assertInitializedRoomSource(room: CollaborationRoom): Promise<void> {
      if (room.project_id !== options.project_id)
        throw Error("foreign Lite collaborators room");
      const rows = await readCollaborationSource(reader, room.chat_path);
      const markers = rows.filter(
        (row: any) => row?.event === "collaborators-room",
      ) as Record<string, unknown>[];
      if (
        markers.length !== 1 ||
        markers[0].room_id !== room.room_id ||
        markers[0].project_id !== room.project_id
      )
        throw Error(
          "human room was deleted or replaced; explicit restore required",
        );
    },
    wrapFilesystem(
      fs: SandboxedFilesystem,
      project_id: string,
    ): SandboxedFilesystem {
      if (project_id !== options.project_id)
        throw Error("foreign Lite collaborators filesystem");
      return journalCollaborationFilesystem(
        fs,
        project_id,
        service.journal,
        home,
      );
    },
    start: () => {
      if (options.personalLibrary)
        artifactRelocation?.bindLibrary(options.personalLibrary());
      service.start();
    },
    stop: () => service.stop(),
    /** Stop/drain the filesystem and room service before releasing the producer lease. */
    async close() {
      await service.close();
      artifactRelocation?.close();
      journalReader?.close();
      reader.close();
      store.close();
    },
  };
}
