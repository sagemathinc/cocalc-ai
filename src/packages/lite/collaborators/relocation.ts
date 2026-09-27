/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { COLLABORATION_MAX_SOURCE_RESOURCES } from "@cocalc/util/collaborators";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import * as validate from "./validation";

export function initializeRelocations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_relocated_sources (
      chat_path TEXT PRIMARY KEY REFERENCES collaboration_sources(chat_path),
      relocated_to TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_relocations (
      operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      epoch TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collaboration_relocation_expiry
      ON collaboration_relocations(created_at);
    CREATE TABLE IF NOT EXISTS collaboration_relocation_intents (
      operation_id TEXT PRIMARY KEY, request TEXT NOT NULL
    );
  `);
}

/** Called inside the owner's synchronous transaction, never through the hub API. */
export function relocateSource(
  db: DatabaseSync,
  opts: Parameters<CollaboratorsApi["relocateSource"]>[0],
  authority: {
    changed(): void;
    revision(): number;
    chargeWork(units: number): void;
    relocateArtifacts?(resources: CollaborationResource[]): void;
  },
): { epoch: string; revision: number } {
  validate.chatPath(opts.from_chat_path);
  validate.chatPath(opts.to_chat_path);
  validate.text(opts.operation_id, "relocation operation");
  validate.text(opts.expected_epoch, "relocation epoch");
  if (opts.expected_destination_epoch !== null)
    validate.text(opts.expected_destination_epoch, "destination epoch");
  if (opts.from_chat_path === opts.to_chat_path)
    throw Error("relocation paths must differ");
  const request_hash = createHash("sha256")
    .update(
      JSON.stringify([
        opts.project_id,
        opts.from_chat_path,
        opts.to_chat_path,
        opts.expected_epoch,
        opts.expected_destination_epoch,
      ]),
    )
    .digest("hex");
  const prior = db
    .prepare("SELECT * FROM collaboration_relocations WHERE operation_id=?")
    .get(opts.operation_id);
  if (prior) {
    if (prior.request_hash !== request_hash)
      throw Error("relocation operation reused with different input");
    return { epoch: prior.epoch as string, revision: Number(prior.revision) };
  }
  const source = db
    .prepare("SELECT * FROM collaboration_sources WHERE chat_path=?")
    .get(opts.from_chat_path);
  const destination = db
    .prepare("SELECT * FROM collaboration_sources WHERE chat_path=?")
    .get(opts.to_chat_path);
  const retired = db.prepare(
    "SELECT 1 FROM collaboration_relocated_sources WHERE chat_path=?",
  );
  if (
    !source ||
    source.epoch !== opts.expected_epoch ||
    retired.get(opts.from_chat_path)
  )
    throw Error("stale relocation source epoch");
  if ((destination?.epoch ?? null) !== opts.expected_destination_epoch)
    throw Error("relocation destination epoch changed");
  if (destination && !retired.get(opts.to_chat_path))
    throw Error("relocation destination is already registered");
  if (
    db
      .prepare(
        "SELECT 1 FROM collaboration_resources WHERE chat_path=? LIMIT 1",
      )
      .get(opts.to_chat_path)
  )
    throw Error("relocation destination has retained resource identities");
  const rows = db
    .prepare(
      "SELECT resource_key,kind,metadata FROM collaboration_resources WHERE chat_path=? LIMIT ?",
    )
    .all(opts.from_chat_path, COLLABORATION_MAX_SOURCE_RESOURCES + 1);
  if (rows.length > COLLABORATION_MAX_SOURCE_RESOURCES)
    throw Error("relocation source size exceeded");
  if (
    !authority.relocateArtifacts &&
    rows.some((row) => row.kind === "artifact")
  )
    throw Error(
      "artifact relocation requires the canonical Library relocation adapter",
    );
  const size = db
    .prepare(
      "SELECT count(*) AS n,coalesce(sum(length(CAST(chat_path AS BLOB))),0) AS bytes FROM collaboration_sources",
    )
    .get()!;
  if (
    !destination &&
    (Number(size.n) >= validate.MAX_SOURCES ||
      Number(size.bytes) + Buffer.byteLength(opts.to_chat_path) >
        validate.MAX_SOURCE_PATH_BYTES)
  )
    throw Error("collaborators source limit exceeded");
  db.prepare("DELETE FROM collaboration_relocations WHERE created_at<?").run(
    Date.now() - 7 * 86400_000,
  );
  if (
    Number(
      db.prepare("SELECT count(*) AS n FROM collaboration_relocations").get()!
        .n,
    ) >= 1000
  )
    throw Error("relocation receipt capacity exceeded");
  authority.chargeWork(Math.max(1, rows.length));
  authority.changed();
  const revision = authority.revision();
  const epoch = randomUUID();
  db.prepare(
    `INSERT INTO collaboration_sources(chat_path,epoch,registration_id,revision) VALUES(?,?,?,?)
    ON CONFLICT(chat_path) DO UPDATE SET epoch=excluded.epoch,registration_id=excluded.registration_id,revision=excluded.revision,
    sequence=0,payload_hash=NULL,metadata_hash=NULL`,
  ).run(opts.to_chat_path, epoch, opts.operation_id, revision);
  db.prepare(
    "DELETE FROM collaboration_relocated_sources WHERE chat_path=?",
  ).run(opts.to_chat_path);
  db.prepare("INSERT INTO collaboration_relocated_sources VALUES(?,?)").run(
    opts.from_chat_path,
    opts.to_chat_path,
  );
  db.prepare(
    "UPDATE collaboration_sources SET epoch=?,registration_id=?,sequence=0,payload_hash=NULL,metadata_hash=NULL WHERE chat_path=?",
  ).run(randomUUID(), randomUUID(), opts.from_chat_path);
  const move = db.prepare(
    "UPDATE collaboration_resources SET chat_path=?,metadata=? WHERE resource_key=?",
  );
  for (const row of rows) {
    const metadata: CollaborationResource = JSON.parse(row.metadata as string);
    if (metadata.kind === "artifact") {
      if (!metadata.artifact_id)
        throw Error("artifact relocation requires a native identity");
      metadata.entry_id = createHash("sha256")
        .update(
          artifactCatalogKey(
            { project_id: opts.project_id, chat_path: opts.to_chat_path },
            {
              thread_id: metadata.thread_id,
              artifact_id: metadata.artifact_id,
            },
          ),
        )
        .digest("hex");
    }
    move.run(
      opts.to_chat_path,
      JSON.stringify({
        ...metadata,
        chat_path: opts.to_chat_path,
      }),
      row.resource_key,
    );
  }
  const bytes = Number(
    db
      .prepare(
        "SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) AS bytes FROM collaboration_resources",
      )
      .get()!.bytes,
  );
  if (bytes > validate.MAX_METADATA_BYTES)
    throw Error("collaborators metadata retention limit exceeded");
  db.prepare("DELETE FROM collaboration_source_coverage WHERE chat_path=?").run(
    opts.to_chat_path,
  );
  db.prepare(
    "UPDATE collaboration_source_coverage SET chat_path=? WHERE chat_path=?",
  ).run(opts.to_chat_path, opts.from_chat_path);
  db.prepare("UPDATE collaboration_room SET chat_path=? WHERE chat_path=?").run(
    opts.to_chat_path,
    opts.from_chat_path,
  );
  db.prepare(
    "INSERT OR IGNORE INTO collaboration_requested_sources SELECT ? FROM collaboration_requested_sources WHERE chat_path=?",
  ).run(opts.to_chat_path, opts.from_chat_path);
  db.prepare(
    "DELETE FROM collaboration_requested_sources WHERE chat_path=?",
  ).run(opts.from_chat_path);
  authority.relocateArtifacts?.(
    rows.map((row) => JSON.parse(row.metadata as string)),
  );
  db.prepare("INSERT INTO collaboration_relocations VALUES(?,?,?,?,?)").run(
    opts.operation_id,
    request_hash,
    epoch,
    revision,
    Date.now(),
  );
  return { epoch, revision };
}
