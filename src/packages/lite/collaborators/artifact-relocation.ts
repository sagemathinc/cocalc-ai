/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LiteArtifactCatalog } from "../artifacts/catalog";
import type { ArtifactCatalogJournal } from "@cocalc/backend/artifacts/journal";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type { PersonalLibraryApi } from "@cocalc/conat/hub/api/personal-library";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  artifactCatalogKey,
  ARTIFACT_CATALOG_MAX_PROJECT_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_ITEMS,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCES,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR,
} from "@cocalc/util/artifact-catalog";
import {
  PERSONAL_LIBRARY_MAX_PIN_BYTES,
  parsePersonalLibraryPinKey,
} from "@cocalc/util/personal-library";

type Request = Parameters<CollaboratorsApi["relocateSource"]>[0];
interface Mapping {
  old_id: string;
  new_id: string;
  thread_id: string;
  artifact_id: string;
}
export interface ArtifactRelocator {
  relocate(
    request: Request,
    resources: CollaborationResource[],
    committed: () => void,
  ): void;
}
export interface LiteArtifactRelocationOptions {
  catalog: LiteArtifactCatalog;
  filename: string;
  journal: ArtifactCatalogJournal;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Existing stores remain authoritative. Receipts recover cross-database commits. */
export class LiteArtifactRelocation implements ArtifactRelocator {
  private readonly db: DatabaseSync;
  private readonly restore: () => void;
  private readonly libraries = new Map<PersonalLibraryApi, () => void>();
  constructor(
    private readonly options: LiteArtifactRelocationOptions & {
      account_id: string;
      project_id: string;
      personalLibraryFilename: string;
      pending(chat_path: string): boolean;
    },
  ) {
    this.db = new DatabaseSync(realpathSync(options.filename));
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
      if (
        this.db
          .prepare(
            "SELECT project_id FROM lite_artifact_project WHERE singleton=1",
          )
          .get()?.project_id !== options.project_id
      )
        throw Error("artifact relocation owner mismatch");
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS lite_collaboration_artifact_redirects (
        old_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lite_collaboration_artifact_redirect_target ON lite_collaboration_artifact_redirects(entry_id);
      CREATE TABLE IF NOT EXISTS lite_collaboration_artifact_retired (chat_path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS lite_collaboration_artifact_moves (
        operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, epoch TEXT NOT NULL,
        mappings TEXT NOT NULL, requeued INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );`);
    } catch (error) {
      this.db.close();
      throw error;
    }
    const { catalog } = options;
    const getEntry = catalog.getEntry;
    const register = catalog.registerSource;
    const apply = catalog.applySnapshot;
    const sourcePage = catalog.sourcePage;
    const assertWritable = (chat_path: string) => {
      if (options.pending(chat_path))
        throw Error("artifact source relocation pending");
      if (this.retired(chat_path)) throw Error("artifact source was relocated");
    };
    catalog.getEntry = async (request) => {
      const redirect = this.db
        .prepare(
          "SELECT entry_id FROM lite_collaboration_artifact_redirects WHERE old_id=?",
        )
        .get(request.entry_id);
      return getEntry.call(catalog, {
        ...request,
        entry_id:
          (redirect?.entry_id as string | undefined) ?? request.entry_id,
      });
    };
    catalog.registerSource = async (request) => {
      assertWritable(request.chat_path);
      return register.call(catalog, request);
    };
    catalog.applySnapshot = async (snapshot) => {
      assertWritable(snapshot.chat_path);
      return apply.call(catalog, snapshot);
    };
    catalog.sourcePage = async (request) => {
      const page = await sourcePage.call(catalog, request);
      return {
        ...page,
        paths: page.paths.filter((path) => !this.retired(path)),
      };
    };
    this.restore = () => {
      catalog.getEntry = getEntry;
      catalog.registerSource = register;
      catalog.applySnapshot = apply;
      catalog.sourcePage = sourcePage;
    };
  }
  private retired(path: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM lite_collaboration_artifact_retired WHERE chat_path=?",
      )
      .get(path);
  }

  /** Old open tabs may still submit pre-move targets to the original Library API. */
  bindLibrary(api: PersonalLibraryApi): void {
    if (this.libraries.has(api)) return;
    const name = api.name,
      setPinned = api.setPinned,
      movePinned = api.movePinned;
    const canonicalPin = (pin: string) => {
      const locator = parsePersonalLibraryPinKey(pin);
      if (locator.project_id !== this.options.project_id) return pin;
      const redirect = this.db
        .prepare(
          "SELECT entry_id FROM lite_collaboration_artifact_redirects WHERE old_id=?",
        )
        .get(hash(pin));
      if (!redirect) return pin;
      const row = this.db
        .prepare(
          "SELECT chat_path,metadata FROM lite_artifact_entries WHERE entry_id=? AND deleted=0",
        )
        .get(redirect.entry_id);
      if (!row) return pin;
      return artifactCatalogKey(
        { project_id: locator.project_id, chat_path: row.chat_path as string },
        JSON.parse(row.metadata as string),
      );
    };
    api.name = async (request) => {
      const redirect =
        request.project_id === this.options.project_id
          ? this.db
              .prepare(
                "SELECT entry_id FROM lite_collaboration_artifact_redirects WHERE old_id=?",
              )
              .get(request.entry_id)
          : undefined;
      return name.call(api, {
        ...request,
        entry_id:
          (redirect?.entry_id as string | undefined) ?? request.entry_id,
      });
    };
    api.setPinned = async (request) =>
      setPinned.call(api, {
        ...request,
        pin_key: canonicalPin(request.pin_key),
      });
    api.movePinned = async (request) =>
      movePinned.call(api, {
        ...request,
        pin_key: canonicalPin(request.pin_key),
        visible: [...new Set(request.visible.map(canonicalPin))],
      });
    this.libraries.set(api, () => {
      api.name = name;
      api.setPinned = setPinned;
      api.movePinned = movePinned;
    });
  }
  relocate(
    request: Request,
    resources: CollaborationResource[],
    committed: () => void,
  ): void {
    if (request.project_id !== this.options.project_id)
      throw Error("artifact relocation owner mismatch");
    const request_hash = hash(
      JSON.stringify([
        request.project_id,
        request.from_chat_path,
        request.to_chat_path,
        request.expected_epoch,
        request.expected_destination_epoch,
      ]),
    );
    const receipt = transaction(this.db, () => {
      const prior = this.db
        .prepare(
          "SELECT * FROM lite_collaboration_artifact_moves WHERE operation_id=?",
        )
        .get(request.operation_id);
      if (prior) {
        if (prior.request_hash !== request_hash)
          throw Error("artifact relocation operation reused");
        return prior;
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM lite_artifact_entries WHERE chat_path=? LIMIT 1",
          )
          .get(request.to_chat_path)
      )
        throw Error("artifact relocation destination occupied");
      const records = this.db
        .prepare(
          "SELECT * FROM lite_artifact_entries WHERE chat_path=? LIMIT 5001",
        )
        .all(request.from_chat_path);
      if (records.length > 5000)
        throw Error("artifact relocation source limit exceeded");
      const mappings = new Map<string, Mapping>();
      const add = (item: { thread_id: string; artifact_id?: string }) => {
        if (!item.artifact_id)
          throw Error("artifact relocation requires a native identity");
        const native = {
          thread_id: item.thread_id,
          artifact_id: item.artifact_id,
        };
        const old_id = hash(
          artifactCatalogKey(
            {
              project_id: request.project_id,
              chat_path: request.from_chat_path,
            },
            native,
          ),
        );
        const new_id = hash(
          artifactCatalogKey(
            { project_id: request.project_id, chat_path: request.to_chat_path },
            native,
          ),
        );
        mappings.set(old_id, { old_id, new_id, ...native });
      };
      for (const row of records) add(JSON.parse(row.metadata as string));
      for (const resource of resources)
        if (resource.kind === "artifact") add(resource);
      const encoded = JSON.stringify([...mappings.values()]);
      this.db
        .prepare(
          "DELETE FROM lite_collaboration_artifact_moves WHERE created_at<?",
        )
        .run(Date.now() - 7 * 86400_000);
      const receipts = this.db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(length(CAST(mappings AS BLOB))),0) AS bytes FROM lite_collaboration_artifact_moves",
        )
        .get()!;
      if (
        Number(receipts.n) >= 1000 ||
        Number(receipts.bytes) + Buffer.byteLength(encoded) > 64 * 1024 * 1024
      )
        throw Error("artifact relocation receipt capacity exceeded");
      const sources = this.db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(length(CAST(chat_path AS BLOB))),0) AS bytes FROM lite_artifact_sources",
        )
        .get()!;
      const destination = this.db
        .prepare("SELECT * FROM lite_artifact_sources WHERE chat_path=?")
        .get(request.to_chat_path);
      if (
        !destination &&
        (Number(sources.n) >= ARTIFACT_CATALOG_MAX_PROJECT_SOURCES ||
          Number(sources.bytes) + Buffer.byteLength(request.to_chat_path) >
            ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES)
      )
        throw Error("artifact relocation source capacity exceeded");
      const budget = this.db
        .prepare("SELECT * FROM lite_artifact_budget WHERE singleton=1")
        .get();
      const now = Date.now(),
        active = budget && now - Number(budget.window_start) < 3_600_000;
      const units =
        (active ? Number(budget.work_units) : 0) + Math.max(1, records.length);
      if (units > ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR)
        throw Error("artifact relocation mutation budget exceeded");
      this.db
        .prepare(
          "INSERT INTO lite_artifact_budget VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET window_start=excluded.window_start,work_units=excluded.work_units",
        )
        .run(active ? budget.window_start : now, units);
      const epoch = randomUUID();
      this.db
        .prepare(
          `INSERT INTO lite_artifact_sources(chat_path,epoch,registration_id,catalog_revision) VALUES(?,?,?,1)
        ON CONFLICT(chat_path) DO UPDATE SET epoch=excluded.epoch,registration_id=excluded.registration_id,source_sequence=0,
        payload_hash=NULL,metadata_hash=NULL,catalog_revision=catalog_revision+1`,
        )
        .run(request.to_chat_path, epoch, request.operation_id);
      this.db
        .prepare(
          "UPDATE lite_artifact_sources SET epoch=?,registration_id=?,source_sequence=0,payload_hash=NULL,metadata_hash=NULL WHERE chat_path=?",
        )
        .run(randomUUID(), randomUUID(), request.from_chat_path);
      this.db
        .prepare(
          "DELETE FROM lite_collaboration_artifact_retired WHERE chat_path=?",
        )
        .run(request.to_chat_path);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO lite_collaboration_artifact_retired VALUES(?)",
        )
        .run(request.from_chat_path);
      for (const mapping of mappings.values()) {
        this.db
          .prepare(
            "UPDATE lite_artifact_entries SET entry_id=?,chat_path=? WHERE entry_id=? AND chat_path=?",
          )
          .run(
            mapping.new_id,
            request.to_chat_path,
            mapping.old_id,
            request.from_chat_path,
          );
        this.db
          .prepare(
            "UPDATE lite_collaboration_artifact_redirects SET entry_id=? WHERE entry_id=?",
          )
          .run(mapping.new_id, mapping.old_id);
        this.db
          .prepare(
            "DELETE FROM lite_collaboration_artifact_redirects WHERE old_id=?",
          )
          .run(mapping.new_id);
        this.db
          .prepare(
            "INSERT INTO lite_collaboration_artifact_redirects VALUES(?,?) ON CONFLICT(old_id) DO UPDATE SET entry_id=excluded.entry_id",
          )
          .run(mapping.old_id, mapping.new_id);
      }
      const size = this.db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(length(CAST(metadata AS BLOB))),0) AS bytes FROM lite_artifact_entries",
        )
        .get()!;
      if (
        Number(size.n) > ARTIFACT_CATALOG_MAX_PROJECT_ITEMS ||
        Number(size.bytes) > ARTIFACT_CATALOG_MAX_PROJECT_BYTES ||
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM lite_collaboration_artifact_redirects",
            )
            .get()!.n,
        ) > 100_000
      )
        throw Error("artifact relocation metadata capacity exceeded");
      this.db
        .prepare(
          "INSERT INTO lite_collaboration_artifact_moves(operation_id,request_hash,epoch,mappings,created_at) VALUES(?,?,?,?,?)",
        )
        .run(request.operation_id, request_hash, epoch, encoded, now);
      return { epoch, mappings: encoded, requeued: 0 };
    });
    committed();
    const mappings = JSON.parse(receipt.mappings as string) as Mapping[];
    const library = new DatabaseSync(
      realpathSync(this.options.personalLibraryFilename),
    );
    try {
      library.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
      transaction(library, () => {
        const owner = library
          .prepare("SELECT * FROM personal_library_owner WHERE singleton=1")
          .get();
        if (
          owner?.account_id !== this.options.account_id ||
          owner?.project_id !== request.project_id
        )
          throw Error("Library relocation owner mismatch");
        library.exec(
          "CREATE TABLE IF NOT EXISTS collaboration_library_moves(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL)",
        );
        const prior = library
          .prepare(
            "SELECT request_hash FROM collaboration_library_moves WHERE operation_id=?",
          )
          .get(request.operation_id);
        if (prior) {
          if (prior.request_hash !== request_hash)
            throw Error("Library relocation operation reused");
          return;
        }
        library
          .prepare("DELETE FROM collaboration_library_moves WHERE created_at<?")
          .run(Date.now() - 7 * 86400_000);
        if (
          Number(
            library
              .prepare("SELECT count(*) AS n FROM collaboration_library_moves")
              .get()!.n,
          ) >= 1000
        )
          throw Error("Library relocation receipt capacity exceeded");
        for (const mapping of mappings) {
          library
            .prepare(
              "UPDATE personal_library_aliases SET entry_id=? WHERE project_id=? AND entry_id=?",
            )
            .run(mapping.new_id, request.project_id, mapping.old_id);
          const before = artifactCatalogKey(
            {
              project_id: request.project_id,
              chat_path: request.from_chat_path,
            },
            mapping,
          );
          const after = artifactCatalogKey(
            { project_id: request.project_id, chat_path: request.to_chat_path },
            mapping,
          );
          const pin = library
            .prepare("SELECT rank FROM personal_library_pins WHERE pin_key=?")
            .get(before);
          if (pin) {
            library
              .prepare("DELETE FROM personal_library_pins WHERE pin_key=?")
              .run(before);
            library
              .prepare(
                "INSERT INTO personal_library_pins VALUES(?,?) ON CONFLICT(pin_key) DO UPDATE SET rank=min(rank,excluded.rank)",
              )
              .run(after, pin.rank);
          }
        }
        if (
          Number(
            library
              .prepare(
                "SELECT coalesce(sum(length(CAST(pin_key AS BLOB))),0) AS bytes FROM personal_library_pins",
              )
              .get()!.bytes,
          ) > PERSONAL_LIBRARY_MAX_PIN_BYTES
        )
          throw Error("Library relocation pin capacity exceeded");
        library
          .prepare("INSERT INTO collaboration_library_moves VALUES(?,?,?)")
          .run(request.operation_id, request_hash, Date.now());
      });
    } finally {
      library.close();
    }
    if (!receipt.requeued) {
      const source = {
        project_id: request.project_id,
        chat_path: request.to_chat_path,
      };
      this.options.journal.finishWrite(this.options.journal.beginWrite(source));
      const journal = new DatabaseSync(
        join(dirname(this.options.filename), "journal.sqlite"),
        { readOnly: true },
      );
      try {
        const row = journal
          .prepare(
            "SELECT epoch,registration_id FROM artifact_sources WHERE project_id=? AND chat_path=?",
          )
          .get(source.project_id, source.chat_path)!;
        const current = row.epoch
          ? {
              ...source,
              epoch: row.epoch as string,
              schema_version: 1 as const,
              sequence: 1,
              items: [],
            }
          : {
              ...source,
              registration_id: row.registration_id as string,
              expected_epoch: null,
            };
        if (
          !this.options.journal.requeueRegistration(
            current,
            receipt.epoch as string,
          )
        )
          throw Error("artifact relocation writer changed");
      } finally {
        journal.close();
      }
      this.db
        .prepare(
          "UPDATE lite_collaboration_artifact_moves SET requeued=1 WHERE operation_id=?",
        )
        .run(request.operation_id);
    }
  }
  close(): void {
    for (const restore of this.libraries.values()) restore();
    this.libraries.clear();
    this.restore();
    this.db.close();
  }
}
