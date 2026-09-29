/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { normalizePrivateAlias } from "@cocalc/util/private-alias";
import type { PersonalLibraryApi } from "@cocalc/conat/hub/api/personal-library";
import { LibraryCompatibility } from "./library";
import type { ClearArtifactAlias } from "./library-store";
import type { ArtifactRelocator } from "./artifact-relocation";
import { AgentPinCompatibility } from "./agent-pins";
import { initializeRelocations, relocateSource } from "./relocation";
import {
  initializeLegacyAttention,
  initializeReadBoundary,
  migrateLegacyAttention,
  recordAttentionChoice,
} from "./legacy-attention";
import type { LiteAgentPins } from "./agent-pins";
import type { ProjectPins } from "@cocalc/backend/collaborators/project-pins";
import {
  COLLABORATION_PAGE_LIMIT,
  COLLABORATION_ROOM_PATH,
  collaborationTargetKey,
  emptyCollaborationPersonalState,
} from "@cocalc/util/collaborators";
import type {
  CollaborationPage,
  CollaborationPersonalState,
  CollaborationPerson,
  CollaborationProject,
  CollaborationProjectQuery,
  CollaborationQuery,
  CollaborationResource,
  CollaborationResourceQuery,
  CollaborationRoom,
  CollaborationTarget,
} from "@cocalc/util/collaborators";
import * as validate from "./validation";
import {
  adaptLiteAgents,
  initializeAgentReferences,
  resolveAgentReference,
  saveLiteAgentBindings,
} from "./agent-identity";
import type { CollaborationAgentIdentity } from "@cocalc/util/collaboration-agent-identity";
import { LiteCollaborationRelations } from "./relations";
import {
  initializeLiteRoomReplacementSchema,
  replaceLiteRoom,
  retiredLiteRoomSource,
} from "./room-replacement";
import type { CollaborationRoomReplacementHostRequest } from "@cocalc/util/collaboration-room-replacement";
import {
  discoveryCoverage,
  validateDiscoveryReport,
} from "@cocalc/util/collaboration-census";
import type {
  CollaborationDiscoveryState,
  CollaborationDiscoveryWrite,
} from "@cocalc/util/collaboration-census";

export interface LiteCollaboratorsOptions {
  /** Service-private file, outside the user-editable project tree. */
  filename: string;
  account_id: string;
  project_id: string;
  isEnabled: () => boolean | Promise<boolean>;
  personalLibrary?: () => PersonalLibraryApi;
  clearArtifactAlias?: ClearArtifactAlias;
  artifactRelocator?: ArtifactRelocator;
  agentPins?: LiteAgentPins;
  /** Optional existing local registry; never enroll sessions on discovery. */
  agentIdentities?: () => readonly CollaborationAgentIdentity[];
  projectPins?: ProjectPins;
  project_title?: string;
  project_description?: string;
  display_name?: string;
  room_path?: string;
  room_home?: string;
}

interface SourceRow {
  epoch: string;
  registration_id: string;
  sequence: number;
  revision: number;
  payload_hash: string | null;
  metadata_hash: string | null;
}

interface ResourceRow {
  resource_key: string;
  metadata: string;
  updated_at: number;
  alias: string | null;
  collected: number | null;
  following: number | null;
  muted: number | null;
  read_through: number | null;
}

interface Cursor {
  version: 1;
  filter: string;
  revision: number;
  updated_at: number;
  key: string;
}

const DEFAULT_COVERAGE =
  "Only service-indexed sources are available. Historical chats, agents and artifacts may be missing; browsing does not scan files.";
const RESOURCE_SELECT = `SELECT r.*,p.alias,p.collected,p.following,p.muted,p.read_through
  FROM collaboration_resources r LEFT JOIN collaboration_personal p USING(resource_key)`;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Standalone, single-user Lite only: the local account is the home authority and
 * the local project is the owner authority. This is not a remote-bay adapter.
 * Export api to the hub, NEVER this instance; writers are service-local only.
 */
export class LiteCollaborators {
  private readonly db: DatabaseSync;
  private readonly library: LibraryCompatibility;
  private readonly agentPins: AgentPinCompatibility;
  private readonly relations: LiteCollaborationRelations;
  readonly api: CollaboratorsApi;

  constructor(private readonly options: LiteCollaboratorsOptions) {
    validate.text(options.account_id, "account");
    validate.text(options.project_id, "project");
    if (options.project_title !== undefined)
      validate.text(options.project_title, "project title", 512);
    if (options.project_description)
      validate.text(options.project_description, "project description", 4096);
    if (options.display_name !== undefined)
      validate.text(options.display_name, "display name", 200);
    validate.chatPath(options.room_path ?? COLLABORATION_ROOM_PATH);
    if (options.filename !== ":memory:") {
      const fd = openSync(options.filename, "a", 0o600);
      closeSync(fd);
      chmodSync(options.filename, 0o600);
    }
    this.db = new DatabaseSync(options.filename);
    initializeLiteRoomReplacementSchema(this.db);
    try {
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS collaboration_owner (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          account_id TEXT NOT NULL, project_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          coverage TEXT NOT NULL DEFAULT 'partial', coverage_message TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collaboration_room (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), room_id TEXT NOT NULL,
          chat_path TEXT NOT NULL, request_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collaboration_discovery (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), report TEXT NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collaboration_initialized_rooms (
          room_id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS collaboration_sources (
          chat_path TEXT PRIMARY KEY, epoch TEXT NOT NULL,
          registration_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0, payload_hash TEXT, metadata_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS collaboration_requested_sources (chat_path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS collaboration_source_coverage (
          chat_path TEXT PRIMARY KEY REFERENCES collaboration_sources(chat_path),
          message TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collaboration_resources (
          resource_key TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
          chat_path TEXT NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL,
          sort_at INTEGER GENERATED ALWAYS AS (-updated_at) STORED,
          created_by TEXT, archived INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS collaboration_resource_page
          ON collaboration_resources(deleted,sort_at,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_resource_kind_page
          ON collaboration_resources(deleted,kind,sort_at,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_resource_source
          ON collaboration_resources(chat_path);
        CREATE INDEX IF NOT EXISTS collaboration_resource_checkpoint
          ON collaboration_resources(chat_path,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_resource_creator
          ON collaboration_resources(created_by,deleted,sort_at,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_artifact_entry
          ON collaboration_resources(kind,deleted,json_extract(metadata,'$.entry_id'));
        CREATE INDEX IF NOT EXISTS collaboration_agent_identity
          ON collaboration_resources(kind,deleted,json_extract(metadata,'$.agent_id'));
        CREATE INDEX IF NOT EXISTS collaboration_artifact_pin
          ON collaboration_resources(kind,deleted,json_array(json_extract(metadata,'$.project_id'),chat_path,json_extract(metadata,'$.thread_id'),json_extract(metadata,'$.artifact_id')));
        CREATE TABLE IF NOT EXISTS collaboration_participants (
          resource_key TEXT NOT NULL REFERENCES collaboration_resources(resource_key),
          account_id TEXT NOT NULL, PRIMARY KEY(resource_key,account_id)
        );
        CREATE INDEX IF NOT EXISTS collaboration_participant_account
          ON collaboration_participants(account_id,resource_key);
        CREATE TABLE IF NOT EXISTS collaboration_personal (
          resource_key TEXT PRIMARY KEY REFERENCES collaboration_resources(resource_key),
          kind TEXT NOT NULL, alias TEXT, collected INTEGER NOT NULL DEFAULT 0,
          following INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
          read_through INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS collaboration_alias
          ON collaboration_personal(kind,alias) WHERE alias IS NOT NULL;
        CREATE INDEX IF NOT EXISTS collaboration_following
          ON collaboration_personal(following,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_collected
          ON collaboration_personal(collected,resource_key);
        CREATE INDEX IF NOT EXISTS collaboration_personal_kind
          ON collaboration_personal(kind,collected,alias);
        CREATE VIRTUAL TABLE IF NOT EXISTS collaboration_search
          USING fts5(title,alias,tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS collaboration_budget (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          window_start INTEGER NOT NULL, work_units INTEGER NOT NULL
        );
      `);
      initializeRelocations(this.db);
      initializeLegacyAttention(this.db);
      initializeAgentReferences(this.db);
      this.transaction(() => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO collaboration_owner
          (singleton,account_id,project_id,coverage_message) VALUES(1,?,?,?)`,
          )
          .run(options.account_id, options.project_id, DEFAULT_COVERAGE);
        const owner = this.db
          .prepare("SELECT * FROM collaboration_owner WHERE singleton=1")
          .get();
        if (
          owner?.account_id !== options.account_id ||
          owner?.project_id !== options.project_id
        )
          throw Error(
            "collaborators database belongs to another account or project",
          );
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    const localOnly = async (): Promise<never> => {
      throw Error("Lite collaborators ingestion is service-local only");
    };
    const invitationsUnavailable = async (opts: {
      account_id?: string;
    }): Promise<never> => {
      await this.assertHuman(opts.account_id);
      throw Error(
        "Invitations are not available in standalone, single-user Lite",
      );
    };
    this.library = new LibraryCompatibility({
      db: this.db,
      account_id: options.account_id,
      project_id: options.project_id,
      api: options.personalLibrary,
      clearAlias: options.clearArtifactAlias,
      revision: () => this.revision(),
      transaction: (run) => this.transaction(run),
      changed: () => this.changed(),
      indexSearch: (key, title) => this.indexSearch(key, title),
    });
    this.agentPins = new AgentPinCompatibility({
      db: this.db,
      pins: options.agentPins,
      revision: () => this.revision(),
      changed: () => this.changed(),
      transaction: (run) => this.transaction(run),
    });
    this.relations = new LiteCollaborationRelations({
      db: this.db,
      project_id: options.project_id,
      transaction: (run) => this.transaction(run),
      revision: () => this.revision(),
      changed: () => this.changed(),
      writer: (snapshot) => {
        this.assertProject(snapshot.project_id);
        this.assertActiveSource(snapshot.chat_path);
        const source = this.source(snapshot.chat_path);
        if (!source || source.epoch !== snapshot.epoch)
          throw Error("stale collaborators relation writer epoch");
        return { ...snapshot, sequence: source.sequence };
      },
    });
    this.api = {
      // Standalone Lite has no other accounts or project invitation service.
      listPeopleContacts: async (opts) => {
        await this.assertHuman(opts.account_id);
        return { items: [], total: 0, revision: this.revisionToken() };
      },
      getPeopleContact: async (opts) => {
        await this.assertHuman(opts.account_id);
        return null;
      },
      getInvitationCounts: async (opts) => {
        await this.assertHuman(opts.account_id);
        return {
          pending: { sent: 0, received: 0 },
          unread: 0,
          revision: this.revisionToken(),
          coverage: "complete",
        };
      },
      listInvitationHistory: async (opts) => ({
        ...(await this.api.getInvitationCounts(opts)),
        items: [],
        total: 0,
      }),
      resolveInvitationRecipient: invitationsUnavailable,
      listInvitationProjects: invitationsUnavailable,
      prepareInvitation: invitationsUnavailable,
      reviewInvitation: invitationsUnavailable,
      sendInvitation: invitationsUnavailable,
      getInvitationOperation: invitationsUnavailable,
      resolveChatAlias: (opts) => this.resolveChatAlias(opts),
      resolvePersonAlias: async (opts) => {
        await this.assertHuman(opts.account_id);
        normalizePrivateAlias(opts.alias);
        return null; // Lite has no other human accounts in its People directory.
      },
      getPersonAlias: async (opts) => {
        await this.assertHuman(opts.account_id);
        throw Error("Person is not accessible");
      },
      setPersonAlias: async (opts) => {
        await this.assertHuman(opts.account_id);
        throw Error("Person is not accessible");
      },
      stageRelationPage: localOnly,
      listParticipants: (opts) => this.listParticipants(opts),
      listReferences: (opts) => this.listReferences(opts),
      getDiscovery: async (opts) => {
        await this.assertHuman(opts.account_id);
        this.assertProject(opts.project_id);
        return this.discoveryState();
      },
      discoveryForHost: localOnly,
      reportDiscovery: localOnly,
      check: (opts) => this.check(opts),
      listPeople: (opts) => this.listPeople(opts),
      listProjects: (opts) => this.listProjects(opts),
      setProjectPinned: (opts) => this.setProjectPinned(opts),
      listResources: (opts) => this.listResources(opts),
      listProjectResources: (opts) => this.listProjectResources(opts),
      requestSource: (opts) => this.requestSource(opts),
      checkpointPage: localOnly,
      getResource: (opts) => this.getResource(opts),
      setPersonalState: (opts) => this.setPersonalState(opts),
      ensureRoom: (opts) => this.ensureRoom(opts),
      getRoom: (opts) =>
        this.registeredRoom({ ...opts, account_id: opts.account_id ?? "" }),
      replaceRoomForHost: localOnly,
      roomForHost: (opts) => this.roomForHost(opts),
      markRoomInitialized: localOnly,
      relocateSource: localOnly,
      writerState: localOnly,
      sourcePage: localOnly,
      registerSource: localOnly,
      ingest: localOnly,
    };
  }

  close(): void {
    this.db.close();
  }

  async roomForHost(
    _opts: Parameters<CollaboratorsApi["roomForHost"]>[0],
  ): Promise<CollaborationRoom> {
    throw Error(
      "Lite collaborators has no remote hosts; room setup is service-local only",
    );
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertAccount(account_id?: string): void {
    if (account_id !== this.options.account_id)
      throw Error("collaborators requires the local Lite account");
  }

  private async assertHuman(account_id?: string): Promise<void> {
    this.assertAccount(account_id);
    if ((await this.options.isEnabled()) !== true)
      throw Error("collaborators is disabled");
    if (
      this.db
        .prepare("SELECT 1 FROM collaboration_relocation_intents LIMIT 1")
        .get()
    )
      throw Error(
        "collaborators relocation recovery in progress; retry shortly",
      );
  }

  private assertProject(project_id: string): void {
    if (project_id !== this.options.project_id)
      throw Error("project is not available in this Lite collaborators index");
  }

  private target(target: CollaborationTarget): string {
    this.assertProject(target.project_id);
    validate.kind(target.kind);
    validate.text(target.resource_id, "resource", 256);
    const key = collaborationTargetKey(target);
    return target.kind === "agent" ? resolveAgentReference(this.db, key) : key;
  }

  private source(chat_path: string): SourceRow | undefined {
    return this.db
      .prepare("SELECT * FROM collaboration_sources WHERE chat_path=?")
      .get(chat_path) as unknown as SourceRow | undefined;
  }

  private revision(): number {
    return Number(
      this.db
        .prepare("SELECT revision FROM collaboration_owner WHERE singleton=1")
        .get()?.revision,
    );
  }

  private changed(): void {
    const revision = this.revision() + 1;
    validate.position(revision, "revision");
    this.db
      .prepare("UPDATE collaboration_owner SET revision=? WHERE singleton=1")
      .run(revision);
  }

  private revisionToken(revision = this.revision(), projectPins = ""): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        account_id: this.options.account_id,
        project_id: this.options.project_id,
        revision: String(revision),
        projectPins,
        expires: Date.now() + 30_000,
      }),
    ).toString("base64url");
  }

  async check(
    opts: Parameters<CollaboratorsApi["check"]>[0],
  ): ReturnType<CollaboratorsApi["check"]> {
    await this.assertHuman(opts.account_id);
    await this.library.refresh();
    await this.assertHuman(opts.account_id);
    this.agentPins.refresh();
    const projectPins = (await this.options.projectPins?.revision()) ?? "";
    await this.assertHuman(opts.account_id);
    const revision = this.revision();
    let reset = true;
    if (typeof opts.since === "string" && opts.since.length <= 1024) {
      try {
        const old = JSON.parse(Buffer.from(opts.since, "base64url").toString());
        reset =
          old.v !== 1 ||
          old.account_id !== this.options.account_id ||
          old.project_id !== this.options.project_id ||
          old.revision !== String(revision) ||
          (old.projectPins ?? "") !== projectPins ||
          !Number.isFinite(old.expires) ||
          old.expires <= Date.now() ||
          old.expires > Date.now() + 30_000;
      } catch {
        // Invalid tokens request a bounded fresh page, never broader access.
      }
    }
    return {
      revision: this.revisionToken(revision, projectPins),
      reset,
      poll_after_ms: 5000,
    };
  }

  private chargeWork(units: number): void {
    const now = Date.now();
    const row = this.db
      .prepare("SELECT * FROM collaboration_budget WHERE singleton=1")
      .get();
    const active = row && now - Number(row.window_start) < 3_600_000;
    const used = (active ? Number(row.work_units) : 0) + units;
    if (used > validate.MAX_WORK_PER_HOUR)
      throw Error("collaborators project mutation budget exceeded");
    this.db
      .prepare(
        `INSERT INTO collaboration_budget VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET window_start=excluded.window_start,work_units=excluded.work_units`,
      )
      .run(active ? row.window_start : now, used);
  }

  /** Durable source recovery for the service producer, not a network API. */
  async writerState(
    opts: Parameters<CollaboratorsApi["writerState"]>[0],
  ): Promise<
    | (SourceRow & {
        source_sequence: number;
        writer_host_id: null;
        retired_room_id?: string;
      })
    | null
  > {
    this.assertProject(opts.project_id);
    validate.chatPath(opts.chat_path);
    const retired = retiredLiteRoomSource(this.db, opts.chat_path);
    if (retired)
      return {
        epoch: String(retired.retired_epoch),
        registration_id: "",
        sequence: 0,
        source_sequence: 0,
        revision: 0,
        payload_hash: null,
        metadata_hash: null,
        writer_host_id: null,
        retired_room_id: String(retired.previous_room_id),
      };
    const source = this.source(opts.chat_path);
    return source
      ? { ...source, source_sequence: source.sequence, writer_host_id: null }
      : null;
  }

  /** Bounded known-source reconciliation; does not discover files. */
  async sourcePage(
    opts: Parameters<CollaboratorsApi["sourcePage"]>[0],
  ): Promise<{ paths: string[]; next?: string }> {
    this.assertProject(opts.project_id);
    const after = opts.after ?? "";
    if (after) validate.chatPath(after);
    const rows = this.db
      .prepare(
        `SELECT chat_path FROM (
          SELECT chat_path FROM collaboration_sources s WHERE chat_path>?
            AND NOT EXISTS(SELECT 1 FROM collaboration_relocated_sources r WHERE r.chat_path=s.chat_path)
          UNION SELECT chat_path FROM collaboration_room WHERE chat_path>?
          UNION SELECT chat_path FROM collaboration_requested_sources q WHERE chat_path>?
            AND NOT EXISTS(SELECT 1 FROM collaboration_relocated_sources r WHERE r.chat_path=q.chat_path)
        ) known WHERE NOT EXISTS(SELECT 1 FROM collaboration_room_replacements r WHERE r.previous_chat_path=known.chat_path)
        ORDER BY chat_path LIMIT 101`,
      )
      .all(after, after, after);
    const paths = rows.slice(0, 100).map((row) => row.chat_path as string);
    return { paths, ...(rows.length > 100 ? { next: paths[99] } : {}) };
  }

  async requestSource(
    opts: Parameters<CollaboratorsApi["requestSource"]>[0],
  ): Promise<{ requested: true }> {
    await this.assertHuman(opts.account_id);
    this.assertProject(opts.project_id);
    validate.chatPath(opts.chat_path);
    this.assertActiveSource(opts.chat_path);
    this.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM collaboration_requested_sources WHERE chat_path=?",
          )
          .get(opts.chat_path)
      )
        return;
      const size = this.db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(length(CAST(chat_path AS BLOB))),0) AS bytes FROM (SELECT chat_path FROM collaboration_requested_sources UNION SELECT chat_path FROM collaboration_sources)",
        )
        .get()!;
      if (
        Number(size.n) >= validate.MAX_SOURCES ||
        Number(size.bytes) + Buffer.byteLength(opts.chat_path) >
          validate.MAX_SOURCE_PATH_BYTES
      )
        throw Error("collaborators source request capacity exceeded");
      this.chargeWork(1);
      this.db
        .prepare("INSERT INTO collaboration_requested_sources VALUES(?)")
        .run(opts.chat_path);
    });
    return { requested: true };
  }

  /** Service-local bounded activity recovery. Tombstones retain their floors. */
  async checkpointPage(
    opts: Parameters<CollaboratorsApi["checkpointPage"]>[0],
  ): ReturnType<CollaboratorsApi["checkpointPage"]> {
    this.assertProject(opts.project_id);
    validate.chatPath(opts.chat_path);
    this.assertActiveSource(opts.chat_path);
    return this.transaction(() => {
      const source = this.source(opts.chat_path);
      if (!source) throw Error("collaborators checkpoint source unavailable");
      const binding = hash([
        opts.project_id,
        opts.chat_path,
        source.epoch,
        source.revision,
      ]);
      let key = "";
      if (opts.after) {
        validate.text(opts.after, "checkpoint cursor", 4096);
        let cursor: any;
        try {
          cursor = JSON.parse(Buffer.from(opts.after, "base64url").toString());
        } catch {
          throw Error("invalid checkpoint cursor");
        }
        if (cursor?.binding !== binding)
          throw Error("checkpoint changed; restart recovery");
        key = validate.text(cursor.key, "checkpoint key", 1024);
      }
      const rows = this.db
        .prepare(
          `SELECT r.resource_key,r.kind,
          CASE WHEN a.resource_key IS NOT NULL THEN 'agent-thread:' || json_extract(r.metadata,'$.thread_id') ELSE r.resource_id END AS resource_id,
          CASE WHEN a.resource_key IS NOT NULL THEN a.source_activity ELSE json_extract(r.metadata,'$.activity') END AS activity
          FROM collaboration_resources r LEFT JOIN collaboration_agent_activity a USING(resource_key)
          WHERE r.chat_path=? AND r.resource_key>? ORDER BY r.resource_key LIMIT 101`,
        )
        .all(opts.chat_path, key);
      return {
        epoch: source.epoch,
        items: rows.slice(0, 100).map((row) => ({
          resource_id: row.resource_id as string,
          kind: row.kind as CollaborationResource["kind"],
          activity: Number(row.activity),
        })),
        ...(rows.length > 100
          ? {
              next: Buffer.from(
                JSON.stringify({ binding, key: rows[99].resource_key }),
              ).toString("base64url"),
            }
          : {}),
      };
    });
  }

  async registerSource(
    opts: Parameters<CollaboratorsApi["registerSource"]>[0],
  ): Promise<{ epoch: string }> {
    this.assertProject(opts.project_id);
    validate.chatPath(opts.chat_path);
    validate.text(opts.registration_id, "registration");
    if (opts.expected_epoch !== null)
      validate.text(opts.expected_epoch, "expected epoch");
    return this.transaction(() => {
      this.assertActiveSource(opts.chat_path);
      const current = this.source(opts.chat_path);
      if (current?.registration_id === opts.registration_id)
        return { epoch: current.epoch };
      if ((current?.epoch ?? null) !== opts.expected_epoch)
        throw Error("collaborators writer epoch changed");
      if (!current) {
        const size = this.db
          .prepare(
            "SELECT count(*) AS n,coalesce(sum(length(CAST(chat_path AS BLOB))),0) AS bytes FROM collaboration_sources",
          )
          .get();
        if (
          Number(size?.n) >= validate.MAX_SOURCES ||
          Number(size?.bytes) + Buffer.byteLength(opts.chat_path) >
            validate.MAX_SOURCE_PATH_BYTES
        )
          throw Error("collaborators source limit exceeded");
      }
      this.chargeWork(1);
      const epoch = randomUUID();
      this.db
        .prepare(
          `INSERT INTO collaboration_sources(chat_path,epoch,registration_id) VALUES(?,?,?)
        ON CONFLICT(chat_path) DO UPDATE SET epoch=excluded.epoch,registration_id=excluded.registration_id,sequence=0,payload_hash=NULL`,
        )
        .run(opts.chat_path, epoch, opts.registration_id);
      return { epoch };
    });
  }

  async ingest(
    opts: Omit<Parameters<CollaboratorsApi["ingest"]>[0], "snapshot"> & {
      snapshot: validate.LocalCollaborationSnapshot;
      /** Service-local floors across all queued event batches, not a network field. */
      initialReadFloors?: ReadonlyMap<string, number>;
    },
  ): Promise<{ revision: number; replayed: boolean }> {
    this.assertProject(opts.snapshot.project_id);
    const snapshot = validate.snapshot(opts.snapshot);
    if (snapshot.relations) await this.assertHuman(this.options.account_id);
    const relations = snapshot.relations
      ? await this.relations.prepare(snapshot.relations)
      : undefined;
    const liveFloors = new Map(opts.initialReadFloors);
    if (liveFloors.size > 5000)
      throw Error("initial read boundary capacity exceeded");
    for (const [thread_id, activity] of liveFloors) {
      validate.text(thread_id, "initial read thread");
      validate.position(activity, "initial read activity");
    }
    for (const event of snapshot.notification_events ?? []) {
      if (
        event.mode !== "live" ||
        event.actor_account_id !== this.options.account_id
      )
        continue;
      liveFloors.set(
        event.thread_id,
        Math.min(
          liveFloors.get(event.thread_id) ?? Number.MAX_SAFE_INTEGER,
          event.activity - 1,
        ),
      );
    }
    // Local queue hints only initialize new identities. Replay remains bound to
    // the frozen source payload, even after its event queue has been acknowledged.
    const payload_hash = hash(snapshot);
    return this.transaction(() => {
      this.assertActiveSource(snapshot.chat_path);
      const current = this.source(snapshot.chat_path);
      if (!current || current.epoch !== snapshot.epoch)
        throw Error("stale collaborators writer epoch");
      if (current.sequence > snapshot.sequence)
        throw Error("stale collaborators source sequence");
      if (current.sequence === snapshot.sequence) {
        if (current.payload_hash !== payload_hash)
          throw Error("collaborators sequence reused with different metadata");
        return { revision: current.revision, replayed: true };
      }
      const { resources: adapted, bindings } = adaptLiteAgents(
        this.db,
        snapshot.resources,
        this.options.agentIdentities?.() ?? [],
      );
      const resources = relations
        ? this.relations.summarize(snapshot, relations, adapted)
        : adapted;
      const metadata_hash = hash([
        resources,
        bindings,
        snapshot.coverage ?? "complete",
        snapshot.coverage_message ?? null,
      ]);
      if (snapshot.notification_events?.length) {
        const room = this.db
          .prepare(
            "SELECT room_id,chat_path FROM collaboration_room WHERE singleton=1",
          )
          .get();
        if (
          !room ||
          room.chat_path !== snapshot.chat_path ||
          snapshot.notification_events.some(
            (event) => event.room_id !== room.room_id,
          )
        )
          throw Error(
            "collaborators notification room is not registered locally",
          );
        // Standalone membership is exactly the local human. Local messages are
        // self-events; imported actors/mentions cannot grant another membership.
        // Hence there is no authorized non-self notification recipient in Lite.
      }
      const replayed = current.metadata_hash === metadata_hash;
      const revision = current.revision + (replayed && !relations ? 0 : 1);
      validate.position(revision, "source revision");
      if (!replayed) {
        this.db
          .prepare(
            "DELETE FROM collaboration_source_coverage WHERE chat_path=?",
          )
          .run(snapshot.chat_path);
        if (snapshot.coverage === "partial")
          this.db
            .prepare("INSERT INTO collaboration_source_coverage VALUES(?,?)")
            .run(
              snapshot.chat_path,
              snapshot.coverage_message ??
                "Participant summaries are incomplete; person and attention filters may omit matches.",
            );
        const old = this.db
          .prepare(
            "SELECT count(*) AS n FROM collaboration_resources WHERE chat_path=? AND deleted=0",
          )
          .get(snapshot.chat_path);
        this.chargeWork(
          Math.max(1, snapshot.resources.length + Number(old?.n)),
        );
        this.db
          .prepare(
            "DELETE FROM collaboration_search WHERE rowid IN (SELECT rowid FROM collaboration_resources WHERE chat_path=?)",
          )
          .run(snapshot.chat_path);
        this.db
          .prepare(
            "DELETE FROM collaboration_participants WHERE resource_key IN (SELECT resource_key FROM collaboration_resources WHERE chat_path=?)",
          )
          .run(snapshot.chat_path);
        // Retain identity/version floors. An omitted identity becomes unavailable,
        // not a reusable slot for another source or a silently retargeted alias.
        this.db
          .prepare(
            "UPDATE collaboration_resources SET deleted=1 WHERE chat_path=?",
          )
          .run(snapshot.chat_path);
        const existing = this.db.prepare(
          "SELECT metadata,chat_path FROM collaboration_resources WHERE resource_key=?",
        );
        const upsert = this.db.prepare(`INSERT INTO collaboration_resources
          (resource_key,kind,resource_id,chat_path,metadata,updated_at,created_by,archived)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET
          metadata=excluded.metadata,updated_at=excluded.updated_at,
          created_by=excluded.created_by,archived=excluded.archived,deleted=0`);
        const participant = this.db.prepare(
          "INSERT INTO collaboration_participants VALUES(?,?)",
        );
        for (const item of resources) {
          const key = collaborationTargetKey(item);
          const row = existing.get(key);
          if (row && row.chat_path !== snapshot.chat_path)
            throw Error(
              "collaborators identity belongs to another source; relocation requires reconciliation",
            );
          const previous = row
            ? (JSON.parse(row.metadata as string) as CollaborationResource)
            : undefined;
          const { lite_legacy_attention, ...metadata } = item;
          const resource = {
            ...metadata,
            created_at: previous?.created_at ?? item.created_at,
            activity: Math.max(previous?.activity ?? 0, item.activity),
          };
          upsert.run(
            key,
            item.kind,
            item.resource_id,
            item.chat_path,
            JSON.stringify(resource),
            item.updated_at,
            item.created_by ?? null,
            item.archived ? 1 : 0,
          );
          for (const id of item.participant_ids) participant.run(key, id);
          if (!previous && resource.kind === "conversation")
            initializeReadBoundary(
              this.db,
              key,
              Math.min(
                resource.activity,
                liveFloors.get(resource.thread_id) ?? resource.activity,
              ),
            );
          migrateLegacyAttention(
            this.db,
            key,
            item.kind,
            lite_legacy_attention,
          );
          this.indexSearch(key, resource.title);
        }
        saveLiteAgentBindings(this.db, bindings);
        for (const { resource } of bindings)
          this.indexSearch(collaborationTargetKey(resource), resource.title);
        const size = this.db
          .prepare(
            "SELECT count(*) AS n,coalesce(sum(length(CAST(metadata AS BLOB))),0) AS bytes FROM collaboration_resources",
          )
          .get();
        if (
          Number(size?.n) > validate.MAX_RESOURCES ||
          Number(size?.bytes) > validate.MAX_METADATA_BYTES
        )
          throw Error("collaborators metadata retention limit exceeded");
        this.changed();
      }
      if (relations) this.relations.activate(snapshot, relations, resources);
      this.db
        .prepare(
          "UPDATE collaboration_sources SET sequence=?,revision=?,payload_hash=?,metadata_hash=? WHERE chat_path=?",
        )
        .run(
          snapshot.sequence,
          revision,
          payload_hash,
          metadata_hash,
          snapshot.chat_path,
        );
      this.relations.prune(snapshot);
      return { revision, replayed: replayed && !relations };
    });
  }

  /** Service-local page writer; the public API explicitly rejects this method. */
  async stageRelationPage(
    opts: Parameters<CollaboratorsApi["stageRelationPage"]>[0],
  ) {
    await this.assertHuman(this.options.account_id);
    this.assertProject(opts.page.snapshot.project_id);
    return this.relations.stage(opts.page);
  }

  async listParticipants(
    opts: Parameters<CollaboratorsApi["listParticipants"]>[0],
  ) {
    if (opts.message_id !== undefined)
      throw Error("participants do not accept a message filter");
    const context = await this.relationReadContext(opts);
    if (!context.key)
      return {
        items: [],
        coverage: context.coverage,
        revision: context.revision,
      };
    const page = this.relations.participants(
      context.key,
      opts,
      context.thread_id,
    );
    return {
      ...page,
      revision: context.revision,
      items: page.items.map((account_id) => ({ account_id })),
    };
  }

  async listReferences(
    opts: Parameters<CollaboratorsApi["listReferences"]>[0],
  ) {
    const context = await this.relationReadContext(opts);
    if (!context.key)
      return {
        items: [],
        coverage: context.coverage,
        revision: context.revision,
      };
    return {
      ...this.relations.references(context.key, opts, context.thread_id),
      revision: context.revision,
    };
  }

  private async relationReadContext(
    opts: Parameters<CollaboratorsApi["listReferences"]>[0],
  ) {
    await this.assertHuman(opts.account_id);
    this.query(opts);
    const resource = await this.getResource(opts);
    const projectPins = (await this.options.projectPins?.revision()) ?? "";
    await this.assertHuman(opts.account_id);
    const revision = this.revisionToken(undefined, projectPins);
    if (!resource) return { revision, coverage: "partial" as const };
    // Recheck live identity after every await. A fresh conversation can change
    // its locator before the background catalog has indexed the new thread.
    const identity =
      resource.agent_id && this.options.agentIdentities
        ? this.options
            .agentIdentities()
            .find(
              (identity) =>
                identity.project_id === resource.project_id &&
                identity.agent_id === resource.agent_id,
            )
        : undefined;
    const chat_path = identity?.path ?? resource.chat_path;
    const thread_id = identity?.thread_id ?? resource.thread_id;
    const key = this.target(opts);
    if (
      (resource.agent_id && this.options.agentIdentities && !identity) ||
      !this.db
        .prepare(
          "SELECT 1 FROM collaboration_resources WHERE resource_key=? AND deleted=0 AND chat_path=? AND json_extract(metadata,'$.thread_id')=?",
        )
        .get(key, chat_path, thread_id)
    )
      return { revision, coverage: "indexing" as const };
    return { key, thread_id, revision, coverage: "complete" as const };
  }

  private indexSearch(key: string, title: string): void {
    const row = this.db
      .prepare(
        "SELECT r.rowid,p.alias FROM collaboration_resources r LEFT JOIN collaboration_personal p USING(resource_key) WHERE resource_key=?",
      )
      .get(key)!;
    this.db
      .prepare("DELETE FROM collaboration_search WHERE rowid=?")
      .run(row.rowid);
    this.db
      .prepare(
        "INSERT INTO collaboration_search(rowid,title,alias) VALUES(?,?,?)",
      )
      .run(row.rowid, title, row.alias ?? "");
  }

  private assertActiveSource(chat_path: string): void {
    if (retiredLiteRoomSource(this.db, chat_path))
      throw Error("canonical room source is permanently retired");
    if (this.isRelocating(chat_path))
      throw Error("collaborators source relocation pending");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM collaboration_relocated_sources WHERE chat_path=?",
        )
        .get(chat_path)
    )
      throw Error("collaborators source was relocated; use its current path");
  }

  /** Durable local owner CAS. The producer acknowledges its filesystem intent afterward. */
  async relocateSource(
    opts: Parameters<CollaboratorsApi["relocateSource"]>[0],
  ): ReturnType<CollaboratorsApi["relocateSource"]> {
    this.assertProject(opts.project_id);
    validate.chatPath(opts.from_chat_path);
    validate.chatPath(opts.to_chat_path);
    validate.text(opts.operation_id, "relocation operation");
    if (
      retiredLiteRoomSource(this.db, opts.from_chat_path) ||
      retiredLiteRoomSource(this.db, opts.to_chat_path)
    )
      throw Error("canonical room source is permanently retired");
    const request = JSON.stringify({
      project_id: opts.project_id,
      from_chat_path: opts.from_chat_path,
      to_chat_path: opts.to_chat_path,
      operation_id: opts.operation_id,
      expected_epoch: opts.expected_epoch,
      expected_destination_epoch: opts.expected_destination_epoch,
    });
    if (this.options.artifactRelocator)
      this.transaction(() => {
        const prior = this.db
          .prepare(
            "SELECT request FROM collaboration_relocation_intents WHERE operation_id=?",
          )
          .get(opts.operation_id);
        if (prior && prior.request !== request)
          throw Error("relocation operation reused with different input");
        if (
          !prior &&
          Number(
            this.db
              .prepare(
                "SELECT count(*) AS n FROM collaboration_relocation_intents",
              )
              .get()!.n,
          ) >= 1000
        )
          throw Error("relocation recovery capacity exceeded");
        this.db
          .prepare(
            "INSERT OR IGNORE INTO collaboration_relocation_intents VALUES(?,?)",
          )
          .run(opts.operation_id, request);
      });
    let externalCommitted = false;
    try {
      return this.transaction(() => {
        const result = relocateSource(this.db, opts, {
          changed: () => this.changed(),
          revision: () => this.revision(),
          chargeWork: (units) => this.chargeWork(units),
          relocateArtifacts: this.options.artifactRelocator
            ? (resources) =>
                this.options.artifactRelocator!.relocate(
                  opts,
                  resources,
                  () => {
                    externalCommitted = true;
                  },
                )
            : undefined,
        });
        this.db
          .prepare(
            "DELETE FROM collaboration_relocation_intents WHERE operation_id=?",
          )
          .run(opts.operation_id);
        return result;
      });
    } catch (error) {
      if (!externalCommitted)
        this.db
          .prepare(
            "DELETE FROM collaboration_relocation_intents WHERE operation_id=?",
          )
          .run(opts.operation_id);
      throw error;
    }
  }

  isRelocating(chat_path: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM collaboration_relocation_intents WHERE json_extract(request,'$.from_chat_path')=? OR json_extract(request,'$.to_chat_path')=? LIMIT 1",
      )
      .get(chat_path, chat_path);
  }

  /** Bounded replay after a crash between authoritative SQLite database commits. */
  async resumeRelocations(): Promise<void> {
    const rows = this.db
      .prepare(
        "SELECT request FROM collaboration_relocation_intents ORDER BY operation_id LIMIT 16",
      )
      .all();
    for (const row of rows)
      await this.relocateSource(JSON.parse(row.request as string));
  }

  private discoveryState(): CollaborationDiscoveryState {
    const row = this.db
      .prepare(
        "SELECT report,updated_at FROM collaboration_discovery WHERE singleton=1",
      )
      .get();
    if (!row) return { status: "pending" };
    const report = validateDiscoveryReport(JSON.parse(String(row.report)));
    return {
      status:
        Number(row.updated_at) < Date.now() - 30 * 60_000
          ? "unavailable"
          : report.coverage,
      report,
      updated_at: Number(row.updated_at),
    };
  }

  /** Service-local metadata only, not exposed as a browser writer. */
  async discoveryForProducer(
    project_id: string,
  ): Promise<{ run_id: string | null }> {
    await this.assertHuman(this.options.account_id);
    this.assertProject(project_id);
    return { run_id: this.discoveryState().report?.run_id ?? null };
  }

  async reportDiscovery(
    write: CollaborationDiscoveryWrite,
  ): Promise<{ replayed: boolean }> {
    await this.assertHuman(this.options.account_id);
    this.assertProject(write.project_id);
    const report = validateDiscoveryReport(write.report);
    return this.transaction(() => {
      const previous = this.discoveryState().report;
      if (previous?.run_id === report.run_id) {
        if (previous.sequence > report.sequence)
          throw Error("stale discovery sequence");
        if (previous.sequence === report.sequence) {
          if (JSON.stringify(previous) !== JSON.stringify(report))
            throw Error("discovery sequence reused with different report");
          return { replayed: true };
        }
      } else if ((previous?.run_id ?? null) !== write.expected_run_id)
        throw Error("stale discovery run");
      this.db
        .prepare(
          "INSERT INTO collaboration_discovery VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET report=excluded.report,updated_at=excluded.updated_at",
        )
        .run(JSON.stringify(report), Date.now());
      if (
        JSON.stringify({ ...previous, sequence: 0 }) !==
        JSON.stringify({ ...report, sequence: 0 })
      )
        this.changed();
      return { replayed: false };
    });
  }

  /** Overall metadata coverage is never claimed complete by the source census. */
  setCoverage(
    coverage: "partial" | "indexing",
    message = DEFAULT_COVERAGE,
  ): void {
    if (coverage !== "partial" && coverage !== "indexing")
      throw Error("invalid collaborators coverage");
    validate.text(message, "coverage message", 512);
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE collaboration_owner SET coverage=?,coverage_message=? WHERE singleton=1 AND (coverage<>? OR coverage_message<>?)",
        )
        .run(coverage, message, coverage, message);
      if (result.changes) this.changed();
    });
  }

  private coverage(): Pick<
    CollaborationPage<never>,
    "coverage" | "coverage_message"
  > {
    const row = this.db
      .prepare(
        "SELECT coverage,coverage_message FROM collaboration_owner WHERE singleton=1",
      )
      .get()!;
    const source = this.db
      .prepare("SELECT message FROM collaboration_source_coverage LIMIT 1")
      .get();
    const discovery = this.discoveryState();
    const base = discovery.report
      ? discoveryCoverage(discovery)
      : {
          coverage: row.coverage as "partial" | "indexing",
          coverage_message: `${row.coverage_message} Historical chat discovery is pending.`,
        };
    return {
      coverage: source ? "partial" : base.coverage,
      coverage_message: source
        ? `${base.coverage_message} ${source.message}`.slice(0, 1024)
        : base.coverage_message,
    };
  }

  private query(opts: CollaborationQuery): { limit: number; terms: string[] } {
    this.assertAccount(opts.account_id);
    if (opts.project_id !== undefined) this.assertProject(opts.project_id);
    if (opts.person_id !== undefined) validate.text(opts.person_id, "person");
    const limit = opts.limit ?? COLLABORATION_PAGE_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > COLLABORATION_PAGE_LIMIT
    )
      throw Error("invalid collaborators page limit");
    if (opts.after !== undefined) validate.text(opts.after, "cursor", 4096);
    return { limit, terms: validate.searchTerms(opts.search) };
  }

  async listPeople(
    opts: CollaborationQuery,
  ): Promise<CollaborationPage<CollaborationPerson>> {
    await this.assertHuman(opts.account_id);
    this.query(opts);
    if (opts.after) throw Error("invalid collaborators people cursor");
    // Lite has no other human collaborators. Resource attribution, imported
    // participant IDs and agent identities do not create account membership.
    const projectPins = (await this.options.projectPins?.revision()) ?? "";
    await this.assertHuman(opts.account_id);
    return {
      items: [],
      coverage: "complete",
      revision: this.revisionToken(undefined, projectPins),
    };
  }

  async listProjects(
    opts: CollaborationProjectQuery,
  ): Promise<CollaborationPage<CollaborationProject>> {
    await this.assertHuman(opts.account_id);
    const { terms } = this.query(opts);
    if (opts.view != null && opts.view !== "recent" && opts.view !== "pinned")
      throw Error("invalid project view");
    if (opts.after) throw Error("invalid collaborators projects cursor");
    if (opts.view === "pinned" && !this.options.projectPins)
      throw Error("project favorites are unavailable");
    const projectPins = (await this.options.projectPins?.revision()) ?? "";
    const revision = this.revisionToken(undefined, projectPins);
    const pins = await this.options.projectPins?.read();
    await this.assertHuman(opts.account_id);
    const project: CollaborationProject = {
      project_id: this.options.project_id,
      title: this.options.project_title ?? "Local project",
      description: this.options.project_description ?? "",
      role: "owner",
      ...(pins ? { pinned: pins.includes(this.options.project_id) } : {}),
    };
    const tokens: string[] =
      `${project.title} ${project.description}`
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    const matches =
      (opts.view !== "pinned" || project.pinned === true) &&
      (!opts.search?.trim() || terms.length > 0) &&
      (!opts.person_id || opts.person_id === this.options.account_id) &&
      terms.every((term) => tokens.some((token) => token.startsWith(term)));
    return { items: matches ? [project] : [], coverage: "complete", revision };
  }

  async setProjectPinned(
    opts: Parameters<CollaboratorsApi["setProjectPinned"]>[0],
  ) {
    await this.assertHuman(opts.account_id);
    this.assertProject(opts.project_id);
    if (typeof opts.pinned !== "boolean") throw Error("invalid project pin");
    if (!this.options.projectPins)
      throw Error("project favorites are unavailable");
    await this.options.projectPins.set(opts.project_id, opts.pinned);
    await this.assertHuman(opts.account_id);
    this.changed();
    return { pinned: opts.pinned };
  }

  private personal(row: ResourceRow): CollaborationPersonalState {
    return {
      ...(row.alias ? { alias: row.alias } : {}),
      collected: row.collected === 1,
      following: row.following === 1,
      muted: row.muted === 1,
      read_through: row.read_through ?? 0,
    };
  }

  private resource(row: ResourceRow, forYou = false): CollaborationResource {
    const result: CollaborationResource = {
      ...JSON.parse(row.metadata),
      project_title: this.options.project_title ?? "Local project",
      personal: this.personal(row),
    };
    if (forYou)
      result.reason = result.personal!.following
        ? "following"
        : "participation";
    return result;
  }

  async resolveChatAlias(
    opts: Parameters<CollaboratorsApi["resolveChatAlias"]>[0],
  ): Promise<CollaborationResource | null> {
    await this.assertHuman(opts.account_id);
    const alias = normalizePrivateAlias(opts.alias);
    const rows = this.db
      .prepare(
        `SELECT r.kind,r.resource_id
      FROM collaboration_personal s JOIN collaboration_resources r USING(resource_key)
      WHERE lower(trim(s.alias))=? AND r.kind IN ('conversation','agent') AND r.deleted=0 LIMIT 2`,
      )
      .all(alias);
    if (rows.length !== 1) return null;
    return this.getResource({
      account_id: opts.account_id,
      project_id: this.options.project_id,
      kind: rows[0].kind as "conversation" | "agent",
      resource_id: rows[0].resource_id as string,
    });
  }

  async getResource(
    opts: Parameters<CollaboratorsApi["getResource"]>[0],
  ): Promise<CollaborationResource | null> {
    await this.assertHuman(opts.account_id);
    const key = this.target(opts);
    await this.library.refresh();
    await this.assertHuman(opts.account_id);
    this.agentPins.refresh();
    const row = this.db
      .prepare(`${RESOURCE_SELECT} WHERE resource_key=? AND r.deleted=0`)
      .get(key) as unknown as ResourceRow | undefined;
    if (!row) return null;
    const resource = this.resource(row);
    if (
      resource.kind === "agent" &&
      resource.agent_id &&
      this.options.agentIdentities
    ) {
      const identity = this.options
        .agentIdentities()
        .find(
          (identity) =>
            identity.project_id === resource.project_id &&
            identity.agent_id === resource.agent_id,
        );
      if (!identity) return null;
      if (resource.thread_id !== identity.thread_id) resource.archived = false;
      resource.chat_path = identity.path;
      resource.thread_id = identity.thread_id;
    }
    return { ...resource, resource_id: opts.resource_id };
  }

  async listResources(
    opts: CollaborationResourceQuery,
    sharedTitlesOnly = false,
  ): Promise<CollaborationPage<CollaborationResource>> {
    await this.assertHuman(opts.account_id);
    const { limit, terms } = this.query(opts);
    await this.library.refresh();
    await this.assertHuman(opts.account_id);
    this.agentPins.refresh();
    if (opts.kind !== undefined) validate.kind(opts.kind);
    if (
      opts.include_unshared != null &&
      typeof opts.include_unshared !== "boolean"
    )
      throw Error("invalid include_unshared");
    let sharedKey: string | undefined;
    if (opts.shared_with) {
      if (opts.shared_with.kind !== "conversation")
        throw Error("shared_with must be a human conversation");
      const context = await this.relationReadContext({
        ...opts.shared_with,
        account_id: opts.account_id,
      });
      sharedKey = context.key;
      if (
        !opts.include_unshared &&
        (!context.key ||
          this.relations.participants(
            context.key,
            { limit: 1 },
            context.thread_id,
          ).coverage !== "complete")
      )
        return {
          items: [],
          coverage: "indexing",
          coverage_message:
            "Participants are still being indexed. Try this project or all my projects.",
        };
      sharedKey = context.key;
    }
    const scope = opts.scope ?? "all";
    if (!["all", "for-you", "following", "collected"].includes(scope))
      throw Error("invalid collaborators scope");
    if (
      opts.include_archived !== undefined &&
      typeof opts.include_archived !== "boolean"
    )
      throw Error("invalid collaborators archived filter");
    const filter = hash([
      this.options.account_id,
      this.options.project_id,
      opts.person_id ?? null,
      terms,
      opts.kind ?? null,
      scope,
      !!opts.include_archived,
      limit,
      sharedTitlesOnly,
      opts.shared_with ?? null,
      !!opts.include_unshared,
    ]);
    const projectPins = (await this.options.projectPins?.revision()) ?? "";
    await this.assertHuman(opts.account_id);
    return this.transaction(() => {
      const revision = this.revision();
      // Capture before querying: later commits must invalidate this page.
      const token = this.revisionToken(revision, projectPins);
      if (
        !opts.include_unshared &&
        sharedKey &&
        (!this.db
          .prepare(
            "SELECT 1 FROM collaboration_resources WHERE resource_key=? AND deleted=0 AND archived=0",
          )
          .get(sharedKey) ||
          this.relations.participants(sharedKey, { limit: 1 }).coverage !==
            "complete")
      )
        return {
          items: [],
          coverage: "indexing",
          revision: token,
          coverage_message:
            "Participants are unavailable or still being indexed. Try another search scope.",
        };
      const clauses = ["r.deleted=0"];
      const args: SQLInputValue[] = [];
      const sharedWithAll =
        !!sharedKey &&
        !!this.db
          .prepare(
            "SELECT 1 FROM collaboration_resources WHERE resource_key=? AND deleted=0 AND archived=0",
          )
          .get(sharedKey) &&
        this.relations.participants(sharedKey, { limit: 1 }).coverage ===
          "complete" &&
        !this.db
          .prepare(
            "SELECT 1 FROM collaboration_full_participants WHERE resource_key=? AND account_id<>? LIMIT 1",
          )
          .get(sharedKey, this.options.account_id);
      if (sharedKey && !opts.include_unshared) {
        // Lite has only one authenticated human. Imported other participants
        // are not members of this local project.
        clauses.push(
          "NOT EXISTS(SELECT 1 FROM collaboration_full_participants WHERE resource_key=? AND account_id<>?)",
        );
        args.push(sharedKey, this.options.account_id);
      }
      if (!opts.include_archived) clauses.push("r.archived=0");
      if (opts.kind) {
        clauses.push("r.kind=?");
        args.push(opts.kind);
      }
      if (opts.person_id) {
        clauses.push(
          "(r.created_by=? OR r.resource_key IN (SELECT resource_key FROM collaboration_full_participants WHERE account_id=?))",
        );
        args.push(opts.person_id, opts.person_id);
      }
      if (scope === "following" || scope === "collected")
        clauses.push(`p.${scope}=1`);
      if (scope === "for-you") {
        clauses.push(
          "(p.following=1 OR r.resource_key IN (SELECT resource_key FROM collaboration_full_participants WHERE account_id=?))",
        );
        args.push(this.options.account_id);
      }
      if (terms.length) {
        clauses.push(
          "r.rowid IN (SELECT rowid FROM collaboration_search WHERE collaboration_search MATCH ?)",
        );
        args.push(
          terms
            .map((term) => `${sharedTitlesOnly ? "title : " : ""}"${term}"*`)
            .join(" AND "),
        );
      }
      if (opts.search?.trim() && !terms.length) clauses.push("0");
      if (opts.after) {
        let cursor: Cursor;
        try {
          cursor = JSON.parse(
            Buffer.from(opts.after, "base64url").toString("utf8"),
          );
        } catch {
          throw Error("invalid collaborators cursor");
        }
        if (!cursor || cursor.version !== 1 || cursor.filter !== filter)
          throw Error("collaborators cursor does not match query");
        if (cursor.revision !== revision)
          throw Error("collaborators index changed; restart pagination");
        validate.position(cursor.updated_at, "cursor position");
        validate.text(cursor.key, "cursor key", 1024);
        clauses.push("(r.sort_at,r.resource_key)>(?,?)");
        args.push(-cursor.updated_at, cursor.key);
      }
      const rows = this.db
        .prepare(
          `${RESOURCE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY r.sort_at,r.resource_key LIMIT ?`,
        )
        .all(...args, limit + 1) as unknown as ResourceRow[];
      const items: CollaborationResource[] = [];
      let bytes = 8192; // Reserve worst-case UTF-8 envelope, cursor and coverage bytes.
      for (const row of rows.slice(0, limit)) {
        const resource = this.resource(row, scope === "for-you");
        if (opts.shared_with)
          resource.shared_with_all_participants = sharedWithAll;
        const size = Buffer.byteLength(JSON.stringify(resource));
        if (bytes + size > validate.MAX_PAGE_BYTES) break;
        items.push(resource);
        bytes += size + 1;
      }
      const last = rows[items.length - 1];
      const next =
        rows.length > items.length && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                filter,
                revision,
                updated_at: last.updated_at,
                key: last.resource_key,
              } satisfies Cursor),
            ).toString("base64url")
          : undefined;
      return {
        items,
        ...(next ? { next } : {}),
        ...this.coverage(),
        revision: token,
      };
    });
  }

  async listProjectResources(
    opts: Parameters<CollaboratorsApi["listProjectResources"]>[0],
  ): Promise<CollaborationPage<CollaborationResource>> {
    await this.assertHuman(opts.account_id);
    if ((opts as CollaborationResourceQuery).scope !== undefined)
      throw Error("project fallback does not accept personal scopes");
    this.assertProject(opts.project_id);
    return this.listResources(opts, true);
  }

  async setPersonalState(
    opts: Parameters<CollaboratorsApi["setPersonalState"]>[0],
  ): Promise<CollaborationPersonalState> {
    await this.assertHuman(opts.account_id);
    const key = this.target(opts);
    const patch = validate.personalPatch(opts.patch);
    if (
      opts.kind === "agent" &&
      patch.collected !== undefined &&
      this.options.agentPins
    ) {
      const resource = await this.getResource(opts);
      if (!resource) throw Error("collaborators resource unavailable");
      if (
        patch.read_through !== undefined &&
        patch.read_through > resource.activity
      )
        throw Error("read marker exceeds current source activity");
      if (patch.alias) this.assertAliasAvailable(opts.kind, patch.alias, key);
      // An unnamed agent thread is still collectable. Do not enroll an execution
      // identity just to create its personal shortcut.
      if (resource.agent_id) {
        this.agentPins.set(resource.agent_id, patch.collected);
        delete patch.collected;
      }
    }
    if (opts.kind === "artifact") {
      const resource = await this.getResource(opts);
      if (!resource) throw Error("collaborators resource unavailable");
      if (
        patch.read_through !== undefined &&
        patch.read_through > resource.activity
      )
        throw Error("read marker exceeds current source activity");
      await this.library.write(resource, patch);
      await this.assertHuman(opts.account_id);
      delete patch.alias;
      delete patch.collected;
    }
    return this.transaction(() => {
      const row = this.db
        .prepare(`${RESOURCE_SELECT} WHERE resource_key=? AND r.deleted=0`)
        .get(key) as unknown as ResourceRow | undefined;
      if (!row) throw Error("collaborators resource unavailable");
      const resource: CollaborationResource = JSON.parse(row.metadata);
      if (
        patch.read_through !== undefined &&
        patch.read_through > resource.activity
      )
        throw Error("read marker exceeds current source activity");
      const previous = this.personal(row);
      const state = {
        ...emptyCollaborationPersonalState(),
        ...previous,
        ...patch,
      };
      state.read_through = Math.max(
        previous.read_through,
        patch.read_through ?? previous.read_through,
      );
      if (!state.alias) delete state.alias;
      if (state.alias) {
        this.assertAliasAvailable(opts.kind, state.alias, key);
      }
      if (opts.kind === "agent" && patch.collected !== undefined)
        this.db
          .prepare(
            "UPDATE collaboration_agent_activity SET collected_fallback=0 WHERE resource_key=?",
          )
          .run(key);
      recordAttentionChoice(this.db, key, patch);
      if (
        previous.alias === state.alias &&
        previous.collected === state.collected &&
        previous.following === state.following &&
        previous.muted === state.muted &&
        previous.read_through === state.read_through
      )
        return state;
      this.db
        .prepare(
          `INSERT INTO collaboration_personal(resource_key,kind,alias,collected,following,muted,read_through)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET
        alias=excluded.alias,collected=excluded.collected,following=excluded.following,
        muted=excluded.muted,read_through=excluded.read_through`,
        )
        .run(
          key,
          opts.kind,
          state.alias ?? null,
          +state.collected,
          +state.following,
          +state.muted,
          state.read_through,
        );
      this.indexSearch(key, resource.title);
      this.changed();
      return state;
    });
  }

  async ensureRoom(
    opts: Parameters<CollaboratorsApi["ensureRoom"]>[0],
  ): Promise<CollaborationRoom> {
    await this.assertHuman(opts.account_id);
    this.assertProject(opts.project_id);
    validate.text(opts.request_id, "room request");
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO collaboration_room VALUES(1,?,?,?)")
        .run(
          randomUUID(),
          this.options.room_path ?? COLLABORATION_ROOM_PATH,
          opts.request_id,
        );
      const row = this.db
        .prepare(
          "SELECT room_id,chat_path,EXISTS(SELECT 1 FROM collaboration_initialized_rooms i WHERE i.room_id=r.room_id) AS initialized FROM collaboration_room r WHERE singleton=1",
        )
        .get()!;
      return {
        project_id: this.options.project_id,
        room_id: row.room_id as string,
        chat_path: row.chat_path as string,
        initialized: row.initialized === 1,
      };
    });
  }

  private assertAliasAvailable(kind: string, alias: string, key: string): void {
    if (
      this.db
        .prepare(
          "SELECT resource_key FROM collaboration_personal WHERE kind=? AND alias=? AND resource_key<>?",
        )
        .get(kind, alias, key)
    )
      throw Error("collaborators alias already used for this resource kind");
  }

  /** Local data-plane authorization/lookup. Unlike ensureRoom this never registers. */
  async registeredRoom(opts: {
    account_id: string;
    project_id: string;
  }): Promise<CollaborationRoom | null> {
    await this.assertHuman(opts.account_id);
    this.assertProject(opts.project_id);
    const row = this.db
      .prepare(
        "SELECT room_id,chat_path,EXISTS(SELECT 1 FROM collaboration_initialized_rooms i WHERE i.room_id=r.room_id) AS initialized FROM collaboration_room r WHERE singleton=1",
      )
      .get();
    return row
      ? {
          project_id: this.options.project_id,
          room_id: row.room_id as string,
          chat_path: row.chat_path as string,
          initialized: row.initialized === 1,
        }
      : null;
  }

  async replaceRoom(opts: CollaborationRoomReplacementHostRequest) {
    await this.assertHuman(opts.requesting_account_id);
    this.assertProject(opts.project_id);
    return this.transaction(() =>
      replaceLiteRoom(
        this.db,
        opts,
        this.options.room_home ?? "/home/user",
        (chat_path) => this.relations.retireSource(chat_path),
      ),
    );
  }

  async roomForService(opts: { account_id: string; project_id: string }) {
    const room = await this.registeredRoom(opts);
    if (!room) return null;
    const retired_rooms = this.db
      .prepare(
        "SELECT previous_room_id AS room_id,previous_chat_path AS chat_path FROM collaboration_room_replacements ORDER BY operation_id LIMIT 33",
      )
      .all() as unknown as Array<{ room_id: string; chat_path: string }>;
    if (retired_rooms.length > 32)
      throw Error("canonical room retirement capacity exceeded");
    return { ...room, ...(retired_rooms.length ? { retired_rooms } : {}) };
  }

  /** Persist only after the local human-room service acknowledges the disk marker. */
  async markRoomInitialized(
    opts: Parameters<CollaboratorsApi["markRoomInitialized"]>[0],
  ): Promise<CollaborationRoom & { initialized: boolean }> {
    await this.assertHuman(opts.requesting_account_id);
    this.assertProject(opts.project_id);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT room_id,chat_path FROM collaboration_room WHERE singleton=1 AND room_id=? AND chat_path=?",
        )
        .get(opts.room_id, opts.chat_path);
      if (!row) throw Error("human room registration changed");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO collaboration_initialized_rooms VALUES(?)",
        )
        .run(opts.room_id);
      return {
        project_id: opts.project_id,
        room_id: opts.room_id,
        chat_path: opts.chat_path,
        initialized: true,
      };
    });
  }
}
