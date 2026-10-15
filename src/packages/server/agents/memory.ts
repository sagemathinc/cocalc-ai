/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-scoped agent memory, on the account's home bay (memory-home.ts
// routes every caller here): one settings row per account and one row per
// note, with descriptions and bodies encrypted. Agent operations see the
// global notes and the namespaces the owner attached to the turn's project;
// the owner's settings page sees and manages everything.
//
// The first version kept all notes in one encrypted external-credential
// record. It is moved here, once, the first time the account is used.

import { createHash } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";
import { assertAccountWriteOnHomeBay } from "@cocalc/database/postgres/account-rehome-fence";
import {
  AGENT_MEMORY_AGENT_SCOPE,
  AGENT_MEMORY_GLOBAL,
  AGENT_MEMORY_LIMITS,
  agentMemoryMarkdown,
  agentMemoryNamespace,
  agentOfMemoryNamespace,
  parseMemoryExpiry,
  buildMemoryIndex,
  memoryBytes,
  memoryRef,
  parseAgentMemoryRecord,
  parseAgentMemorySettings,
  parseMemoryRef,
  projectMemoryNamespaces,
  rankMemoryNotes,
  searchMemoryNotes,
  validateAgentMemoryOwnerRequest,
  validateAgentMemoryRequest,
  validateMemoryNamespace,
  validateMemoryNamespaceDescription,
  validateMemoryWrite,
  type AgentMemoryCaller,
  type AgentMemoryNamespace,
  type AgentMemoryNote,
  type AgentMemoryNoteSummary,
  type AgentMemoryOwnerRequest,
  type AgentMemoryRef,
  type AgentMemoryRequest,
  type AgentMemorySettings,
  type AgentMemoryStatus,
  type LegacyAgentMemoryRecord,
} from "@cocalc/conat/agents/memory";
import { isValidUUID } from "@cocalc/util/misc";
import { chargeAgentMemoryUsage } from "./memory-limits";

const logger = getLogger("agents:memory");

export const AGENT_MEMORY_DISABLED =
  "Agent memory is off for this account. The account owner can turn it on in Settings > AI.";

const GLOBAL = AGENT_MEMORY_GLOBAL;
// An absorb that found the first-version record changed under it.
const STALE = Symbol("stale");
// The turn index never shows more lines than this, so it decrypts no more.
const INDEX_CANDIDATES = 400;
const DAY_SECONDS = 24 * 60 * 60;
// Authorship and expiry hold only for the write that set them: a later
// write by a hub that does not keep them (a rolling upgrade, the
// first-version record) changes updated_at without them.
const ATTRIBUTED = "attributed_at = updated_at";
// Notes past their expiry act as deleted until the sweep removes them.
const LIVE = `(expires_at IS NULL OR expires_at > now() OR NOT COALESCE(${ATTRIBUTED}, false))`;

type Rows = { rows: any[]; rowCount?: number | null };
export type MemoryDb = {
  query(sql: string, params?: unknown[]): Promise<Rows>;
};
type MemoryPool = MemoryDb & {
  connect(): Promise<MemoryDb & { release(): void }>;
};

export type AgentMemoryDeps = {
  pool(): MemoryPool;
  encrypt(aad: string, text: string): Promise<string>;
  decrypt(aad: string, text: string): Promise<string>;
  /**
   * The first version's single record. Hubs still running the first version
   * may write it during a rolling upgrade, so it is absorbed whenever its
   * content changes and is not deleted here (except by "delete all"): a
   * first-version writer that read it before a deletion would lose its
   * write without noticing. A later release deletes these records once no
   * first-version hub can be running.
   */
  legacy: {
    /** With db, on that connection (never a second one under a lock). */
    get(account_id: string, db?: MemoryDb): Promise<LegacyRecord | undefined>;
    remove(account_id: string, db?: MemoryDb): Promise<void>;
  };
  assertWritable(db: MemoryDb, account_id: string): Promise<void>;
  /** Rate limits for agent operations; the owner is never charged. */
  charge(
    account_id: string,
    op: "read" | "write",
    bytes?: number,
  ): Promise<void>;
};

export type LegacyRecord = {
  payload: string;
  /** A hash of the content: changes whenever the content does. */
  version: string;
};

export const defaultAgentMemoryDeps: AgentMemoryDeps = {
  pool: () => getPool() as unknown as MemoryPool,
  encrypt: (aad, text) => encryptSecretStorageValue(aad, text),
  decrypt: async (aad, text) =>
    (await decryptSecretStorageValue(aad, text)).value,
  legacy: {
    async get(account_id, db) {
      // Memory requests run on the account's home bay, where account-scoped
      // credentials live, so this is a local read (the same row and
      // associated data as the external-credential store).
      const { rows } = await (db ?? getPool()).query(
        `SELECT encrypted_payload FROM external_credentials
          WHERE provider='cocalc' AND kind='agent-memory' AND scope='account'
            AND owner_account_id=$1 AND project_id IS NULL
            AND organization_id IS NULL AND revoked IS NULL
          ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST LIMIT 1`,
        [account_id],
      );
      if (!rows[0]) return undefined;
      const payload = (
        await decryptSecretStorageValue(
          "external_credentials:cocalc:agent-memory:account",
          rows[0].encrypted_payload,
        )
      ).value;
      return {
        payload,
        version: createHash("sha256").update(payload).digest("hex"),
      };
    },
    async remove(account_id, db) {
      // Deleted, not revoked: deleting memory must not leave an encrypted
      // copy behind.
      await (db ?? getPool()).query(
        `DELETE FROM external_credentials
          WHERE provider='cocalc' AND kind='agent-memory' AND scope='account'
            AND owner_account_id=$1`,
        [account_id],
      );
    },
  },
  assertWritable: (db, account_id) =>
    assertAccountWriteOnHomeBay({
      db: db as any,
      account_id,
      action: "change agent memory",
    }),
  charge: (account_id, op, bytes) =>
    chargeAgentMemoryUsage(account_id, op, bytes),
};

/** Identifies one note's content in the first version's record. */
function legacyFingerprint(note: {
  name: string;
  description: string;
  body: string;
  updated_at: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([note.name, note.description, note.body, note.updated_at]),
    )
    .digest("hex")
    .slice(0, 32);
}

const aad = (
  account_id: string,
  namespace: string,
  name: string,
  field: "description" | "body",
) => `agent-memory:${account_id}:${namespace}:${name}:${field}`;

const iso = (value: unknown): string | null =>
  value == null ? null : new Date(value as any).toISOString();

type NoteRow = {
  namespace: string;
  name: string;
  description: string;
  body?: string;
  bytes: number;
  project_id: string | null;
  updated_at: Date | string;
  last_read_at: Date | string | null;
  read_count: number;
  written_by_agent_id?: string | null;
  written_by_name?: string | null;
  ttl_seconds?: number | null;
  expires_at?: Date | string | null;
  attributed_at?: Date | string | null;
};

const NOTE_COLUMNS = `namespace, name, description, bytes, project_id, updated_at,
  last_read_at, read_count, written_by_agent_id, written_by_name, ttl_seconds,
  expires_at, attributed_at`;

/** What the owner sees: while memory is off, nothing expires. */
const ownerLive = (enabled: boolean) => (enabled ? LIVE : "TRUE");

/** Whether a row's authorship and expiry still describe its content. */
function attributed(row: {
  updated_at?: Date | string | null;
  attributed_at?: Date | string | null;
}): boolean {
  if (row.attributed_at == null || row.updated_at == null) return false;
  return (
    new Date(row.attributed_at as any).getTime() ===
    new Date(row.updated_at as any).getTime()
  );
}

const writer = (row: NoteRow) =>
  attributed(row) ? (row.written_by_name ?? null) : null;
const expiry = (row: NoteRow) => (attributed(row) ? iso(row.expires_at) : null);

/**
 * Identifies a note's content, so a write can refuse to replace a change
 * made since its caller read the note.
 */
function memoryRevision(description: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([description, body]))
    .digest("hex")
    .slice(0, 16);
}

function notAvailable(namespace: string) {
  // The same answer whether or not the namespace exists.
  return new Error(
    `memory namespace ${namespace} is not available in this project`,
  );
}

const noAgentScope = () =>
  new Error(
    "agent/<name> notes need a registered agent identity; this turn has none",
  );

function readOnlyScope(agent: string) {
  return new Error(
    `@${agent}/ notes belong to @${agent}: other agents can read them but only @${agent} writes them; save yours as agent/<name>`,
  );
}

/** The guard against silently replacing what another writer saved. */
function otherWriter(
  ref: string,
  row: { written_by_agent_id?: string | null; written_by_name?: string | null },
  caller: AgentMemoryCaller | undefined,
  what: "replace" | "delete" | "move",
) {
  return new Error(
    `memory note ${ref} was last written by ${
      row.written_by_name ? `@${row.written_by_name}` : "another agent"
    }; to ${what} it, read it and pass the revision you read${
      what === "replace"
        ? caller
          ? ", or save yours under another name or as agent/<name>"
          : ", or save yours under another name"
        : ""
    }`,
  );
}

const writtenByOther = (
  row: {
    written_by_agent_id?: string | null;
    updated_at?: Date | string | null;
    attributed_at?: Date | string | null;
  },
  caller: AgentMemoryCaller | undefined,
) =>
  attributed(row) &&
  row.written_by_agent_id != null &&
  row.written_by_agent_id !== caller?.agent_id;

/** A display name usable as @name, for an agent the account does not list. */
function agentNameFallback(name: string): string {
  const cleaned = `${name ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return cleaned || "agent";
}

export function createAgentMemory(
  deps: AgentMemoryDeps = defaultAgentMemoryDeps,
) {
  const pool = () => deps.pool();

  async function transaction<T>(
    account_id: string,
    fn: (db: MemoryDb) => Promise<T>,
  ): Promise<T> {
    const db = await pool().connect();
    try {
      await db.query("BEGIN");
      // One writer per account at a time, across every hub process.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('agent-memory:' || $1, 0))",
        [account_id],
      );
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  async function loadSettings(
    db: MemoryDb,
    account_id: string,
  ): Promise<AgentMemorySettings | undefined> {
    const { rows } = await db.query(
      "SELECT enabled, namespaces, projects FROM agent_memory_accounts WHERE account_id=$1",
      [account_id],
    );
    return rows[0] ? parseAgentMemorySettings(rows[0]) : undefined;
  }

  async function saveSettings(
    db: MemoryDb,
    account_id: string,
    settings: AgentMemorySettings,
  ) {
    await db.query(
      `INSERT INTO agent_memory_accounts (account_id, enabled, namespaces, projects, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (account_id) DO UPDATE SET enabled=EXCLUDED.enabled,
         namespaces=EXCLUDED.namespaces, projects=EXCLUDED.projects, updated_at=now()`,
      [
        account_id,
        settings.enabled,
        JSON.stringify(settings.namespaces),
        JSON.stringify(settings.projects),
      ],
    );
  }

  async function encryptNote(
    account_id: string,
    namespace: string,
    name: string,
    description: string,
    body: string,
  ) {
    return {
      description: await deps.encrypt(
        aad(account_id, namespace, name, "description"),
        description,
      ),
      body: await deps.encrypt(aad(account_id, namespace, name, "body"), body),
    };
  }

  const decryptField = (
    account_id: string,
    row: { namespace: string; name: string },
    field: "description" | "body",
    value: string,
  ) => deps.decrypt(aad(account_id, row.namespace, row.name, field), value);

  /**
   * Absorbs the first version's single record into rows whenever its content
   * changed since it was last absorbed: on first use, and again whenever a
   * hub still running the first version writes it during a rolling upgrade.
   * The first time takes every note; later times only notes the old hub
   * actually changed or added, judged by each note's fingerprint in the
   * record last absorbed (so an unchanged copy of a note deleted here does
   * not bring it back), and a note wins only if it is newer than its row. A
   * note an old hub deleted is not deleted here.
   * Accounts that never used memory get no row until the owner changes a
   * setting.
   */
  async function absorb(
    account_id: string,
    legacy: LegacyRecord,
  ): Promise<AgentMemorySettings | undefined | typeof STALE> {
    const { rows: seen } = await pool().query(
      "SELECT legacy_version FROM agent_memory_accounts WHERE account_id=$1",
      [account_id],
    );
    if (seen[0]?.legacy_version === legacy.version) return undefined;
    let record: LegacyAgentMemoryRecord;
    try {
      record = parseAgentMemoryRecord(legacy.payload);
    } catch (err) {
      // Nobody could repair it but the owner, who can only delete it, so it
      // is kept and ignored.
      logger.warn("unreadable first-version agent memory; ignoring it", {
        account_id,
        err: `${err}`,
      });
      return undefined;
    }
    const encrypted = await Promise.all(
      record.notes.map(async (note) => ({
        note,
        ...(await encryptNote(
          account_id,
          GLOBAL,
          note.name,
          note.description,
          note.body,
        )),
      })),
    );
    return await transaction(account_id, async (db) => {
      const { rows } = await db.query(
        `SELECT enabled, namespaces, projects, legacy_version, legacy_notes
           FROM agent_memory_accounts WHERE account_id=$1`,
        [account_id],
      );
      const row = rows[0];
      if (row?.legacy_version === legacy.version)
        return parseAgentMemorySettings(row);
      // Read before the lock: if the record changed since, a newer version
      // may already be absorbed, and absorbing this one would undo it.
      if ((await deps.legacy.get(account_id, db))?.version !== legacy.version)
        return STALE;
      await deps.assertWritable(db, account_id);
      // Each note's fingerprint in the record absorbed last time; none the
      // first time, when every note is taken.
      const previous: Record<string, string> | undefined =
        row?.legacy_notes ?? undefined;
      const fingerprints: Record<string, string> = {};
      const settings: AgentMemorySettings = row
        ? parseAgentMemorySettings(row)
        : { enabled: record.enabled, namespaces: [], projects: {} };
      if (!row)
        await db.query(
          `INSERT INTO agent_memory_accounts (account_id, enabled, namespaces, projects, migrated_at, updated_at)
           VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, now(), now())`,
          [account_id, record.enabled],
        );
      for (const { note, description, body } of encrypted) {
        const fingerprint = legacyFingerprint(note);
        fingerprints[note.name] = fingerprint;
        if (previous && previous[note.name] === fingerprint) continue;
        await db.query(
          `INSERT INTO agent_memory_notes
             (account_id, namespace, name, description, body, bytes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (account_id, namespace, name) DO UPDATE SET
             description=EXCLUDED.description, body=EXCLUDED.body,
             bytes=EXCLUDED.bytes, updated_at=EXCLUDED.updated_at,
             -- Nobody known wrote this content, and it does not expire.
             written_by_agent_id=NULL, written_by_name=NULL,
             ttl_seconds=NULL, expires_at=NULL, attributed_at=NULL
           WHERE agent_memory_notes.updated_at < EXCLUDED.updated_at`,
          [
            account_id,
            GLOBAL,
            note.name,
            description,
            body,
            memoryBytes(note.description) + memoryBytes(note.body),
            note.updated_at,
          ],
        );
      }
      await db.query(
        `UPDATE agent_memory_accounts
            SET legacy_version=$2, legacy_notes=$3::jsonb, legacy_absorbed_at=now()
          WHERE account_id=$1`,
        [account_id, legacy.version, JSON.stringify(fingerprints)],
      );
      return settings;
    });
  }

  async function settingsOf(account_id: string): Promise<AgentMemorySettings> {
    // A few tries: each stale one means an old hub just wrote the record.
    for (let attempt = 0; attempt < 3; attempt++) {
      const legacy = await deps.legacy.get(account_id);
      if (!legacy) break;
      const absorbed = await absorb(account_id, legacy);
      if (absorbed === STALE) continue;
      if (absorbed) return absorbed;
      break;
    }
    return (
      (await loadSettings(pool(), account_id)) ?? {
        enabled: false,
        namespaces: [],
        projects: {},
      }
    );
  }

  /** The settings row, created (and the legacy record moved) if missing. */
  async function settingsForUpdate(
    db: MemoryDb,
    account_id: string,
  ): Promise<AgentMemorySettings> {
    const existing = await loadSettings(db, account_id);
    if (existing) return existing;
    await deps.assertWritable(db, account_id);
    const created = { enabled: false, namespaces: [], projects: {} };
    await saveSettings(db, account_id, created);
    return created;
  }

  async function noteRows(
    db: MemoryDb,
    account_id: string,
    namespaces: string[] | undefined,
    withBody = false,
    // While memory is off nothing expires, so the owner still sees it all.
    live = LIVE,
  ): Promise<NoteRow[]> {
    const { rows } = await db.query(
      `SELECT ${withBody ? "body," : ""} ${NOTE_COLUMNS}
         FROM agent_memory_notes
        WHERE account_id=$1 AND ($2::text[] IS NULL OR namespace = ANY($2::text[]))
          AND ${live}`,
      [account_id, namespaces ?? null],
    );
    return rows;
  }

  async function decryptRows(
    account_id: string,
    rows: NoteRow[],
  ): Promise<AgentMemoryNote[]> {
    return await Promise.all(
      rows.map(async (row) => ({
        namespace: row.namespace,
        name: row.name,
        description: await decryptField(
          account_id,
          row,
          "description",
          row.description,
        ),
        body:
          row.body == null
            ? ""
            : await decryptField(account_id, row, "body", row.body),
        updated_at: iso(row.updated_at)!,
        last_read_at: iso(row.last_read_at),
        written_by: writer(row),
        expires_at: expiry(row),
      })),
    );
  }

  async function summaries(
    account_id: string,
    rows: NoteRow[],
  ): Promise<AgentMemoryNoteSummary[]> {
    return await Promise.all(
      rows.map(async (row) => ({
        namespace: row.namespace,
        name: row.name,
        description: await decryptField(
          account_id,
          row,
          "description",
          row.description,
        ),
        updated_at: iso(row.updated_at)!,
        last_read_at: iso(row.last_read_at),
        bytes: Number(row.bytes),
        project_id: row.project_id,
        read_count: Number(row.read_count),
        written_by: writer(row),
        expires_at: expiry(row),
      })),
    );
  }

  /** Where an existing note is, among the namespaces this caller sees. */
  async function locate(
    db: MemoryDb,
    account_id: string,
    ref: AgentMemoryRef,
    visible: string[],
  ): Promise<string | undefined> {
    if (ref.namespace) {
      if (!visible.includes(ref.namespace)) throw notAvailable(ref.namespace);
      const { rows } = await db.query(
        `SELECT 1 FROM agent_memory_notes
          WHERE account_id=$1 AND namespace=$2 AND name=$3 AND ${LIVE}`,
        [account_id, ref.namespace, ref.name],
      );
      return rows.length ? ref.namespace : undefined;
    }
    const { rows } = await db.query(
      `SELECT namespace FROM agent_memory_notes
        WHERE account_id=$1 AND name=$2 AND namespace = ANY($3::text[]) AND ${LIVE}`,
      [account_id, ref.name, visible],
    );
    if (rows.length > 1)
      throw new Error(
        `more than one memory note is named ${ref.name} (${rows
          .map((r) =>
            r.namespace === GLOBAL
              ? `global/${ref.name}`
              : `${r.namespace}/${ref.name}`,
          )
          .sort()
          .join(", ")}); name one of them`,
      );
    return rows[0]?.namespace;
  }

  async function mustLocate(
    db: MemoryDb,
    account_id: string,
    ref: AgentMemoryRef,
    visible: string[],
  ): Promise<string> {
    const namespace = await locate(db, account_id, ref, visible);
    if (!namespace)
      throw new Error(
        `no memory note named ${ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name}`,
      );
    return namespace;
  }

  function defaultNamespace(projectNamespaces: AgentMemoryNamespace[]): string {
    if (projectNamespaces.length === 0) return GLOBAL;
    if (projectNamespaces.length === 1) return projectNamespaces[0].name;
    throw new Error(
      `this project has several memory namespaces (${projectNamespaces
        .map((ns) =>
          ns.description ? `${ns.name}: ${ns.description}` : ns.name,
        )
        .join(
          "; ",
        )}); name one, as <namespace>/<name>, or global/<name> for a note that applies in every project`,
    );
  }

  async function usage(db: MemoryDb, account_id: string, namespace: string) {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE namespace=$2)::int AS in_namespace,
              count(*)::int AS notes, coalesce(sum(bytes),0)::bigint AS bytes
         FROM agent_memory_notes WHERE account_id=$1 AND ${LIVE}`,
      [account_id, namespace],
    );
    return {
      inNamespace: Number(rows[0]?.in_namespace ?? 0),
      notes: Number(rows[0]?.notes ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
    };
  }

  /**
   * Room for a change. The namespace's own limit is reported in full; the
   * account-wide limits count notes in namespaces this caller may not see,
   * so agents get no numbers for those (the owner does).
   */
  async function checkRoom(
    db: MemoryDb,
    account_id: string,
    namespace: string,
    add: { namespaceNotes: number; accountNotes: number; bytes: number },
    owner: boolean,
  ) {
    const now = await usage(db, account_id, namespace);
    const full = (what: string) =>
      new Error(
        `agent memory ${what}; merge related notes and delete outdated ones first`,
      );
    const agentScope = agentOfMemoryNamespace(namespace) != null;
    const namespaceLimit = agentScope
      ? AGENT_MEMORY_LIMITS.maxNotesPerAgent
      : AGENT_MEMORY_LIMITS.maxNotesPerNamespace;
    if (
      add.namespaceNotes > 0 &&
      now.inNamespace + add.namespaceNotes > namespaceLimit
    )
      throw full(
        `already has ${namespaceLimit} notes in ${
          agentScope
            ? `your own scope (${AGENT_MEMORY_AGENT_SCOPE}/)`
            : namespace
        }`,
      );
    const accountFull =
      (add.accountNotes > 0 &&
        now.notes + add.accountNotes > AGENT_MEMORY_LIMITS.maxNotes) ||
      (add.bytes > 0 &&
        now.bytes + add.bytes > AGENT_MEMORY_LIMITS.maxAccountBytes);
    if (!accountFull) return;
    if (!owner)
      throw new Error(
        "agent memory has no room for this note; the account owner can review and tidy it in Settings > AI",
      );
    throw full(
      now.notes + add.accountNotes > AGENT_MEMORY_LIMITS.maxNotes
        ? `already has ${AGENT_MEMORY_LIMITS.maxNotes} notes`
        : `would exceed ${AGENT_MEMORY_LIMITS.maxAccountBytes / 1_000_000} MB`,
    );
  }

  async function writeNote(
    db: MemoryDb,
    account_id: string,
    namespace: string,
    name: string,
    description: string,
    body: string,
    project_id: string | null,
    caller: AgentMemoryCaller | undefined,
    // undefined keeps an existing note's expiry; null means never.
    ttl_seconds: number | null | undefined,
  ): Promise<"created" | "updated"> {
    const bytes = memoryBytes(description) + memoryBytes(body);
    // An expired note is gone: its name is free again.
    await db.query(
      `DELETE FROM agent_memory_notes
        WHERE account_id=$1 AND namespace=$2 AND name=$3 AND NOT ${LIVE}`,
      [account_id, namespace, name],
    );
    const { rows } = await db.query(
      "SELECT bytes FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2 AND name=$3",
      [account_id, namespace, name],
    );
    const before = rows[0] ? Number(rows[0].bytes) : undefined;
    const added = before === undefined ? 1 : 0;
    await checkRoom(
      db,
      account_id,
      namespace,
      {
        namespaceNotes: added,
        accountNotes: added,
        bytes: bytes - (before ?? 0),
      },
      false,
    );
    const encrypted = await encryptNote(
      account_id,
      namespace,
      name,
      description,
      body,
    );
    // A new note in an agent's own scope expires by default; elsewhere it
    // is kept until deleted.
    const ttl =
      ttl_seconds !== undefined
        ? ttl_seconds
        : before === undefined && agentOfMemoryNamespace(namespace)
          ? AGENT_MEMORY_LIMITS.agentNoteDefaultTtlDays * DAY_SECONDS
          : undefined;
    await db.query(
      `INSERT INTO agent_memory_notes
         (account_id, namespace, name, description, body, bytes, project_id,
          written_by_agent_id, written_by_name, ttl_seconds, expires_at,
          created_at, updated_at, attributed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int,
               now() + make_interval(secs => $10::int), now(), now(), now())
       ON CONFLICT (account_id, namespace, name) DO UPDATE SET
         description=EXCLUDED.description, body=EXCLUDED.body, bytes=EXCLUDED.bytes,
         project_id=COALESCE(EXCLUDED.project_id, agent_memory_notes.project_id),
         written_by_agent_id=EXCLUDED.written_by_agent_id,
         written_by_name=EXCLUDED.written_by_name,
         ttl_seconds=CASE WHEN $11::boolean THEN EXCLUDED.ttl_seconds
                          WHEN agent_memory_notes.attributed_at = agent_memory_notes.updated_at
                          THEN agent_memory_notes.ttl_seconds END,
         expires_at=now() + make_interval(secs => CASE WHEN $11::boolean THEN EXCLUDED.ttl_seconds
                          WHEN agent_memory_notes.attributed_at = agent_memory_notes.updated_at
                          THEN agent_memory_notes.ttl_seconds END),
         updated_at=now(), attributed_at=now()`,
      [
        account_id,
        namespace,
        name,
        encrypted.description,
        encrypted.body,
        bytes,
        project_id,
        caller?.agent_id ?? null,
        caller?.name ?? null,
        ttl ?? null,
        ttl !== undefined,
      ],
    );
    return before === undefined ? "created" : "updated";
  }

  async function moveNote(
    db: MemoryDb,
    account_id: string,
    from: string,
    name: string,
    to: string,
    owner: boolean,
  ) {
    if (from === to) return;
    const { rows } = await db.query(
      `SELECT namespace, name, description, body, bytes FROM agent_memory_notes
        WHERE account_id=$1 AND namespace=$2 AND name=$3 AND ${LIVE}`,
      [account_id, from, name],
    );
    if (!rows[0])
      throw new Error(`no memory note named ${memoryRef(from, name, true)}`);
    await db.query(
      `DELETE FROM agent_memory_notes
        WHERE account_id=$1 AND namespace=$2 AND name=$3 AND NOT ${LIVE}`,
      [account_id, to, name],
    );
    const { rows: taken } = await db.query(
      "SELECT 1 FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2 AND name=$3",
      [account_id, to, name],
    );
    if (taken.length)
      throw new Error(
        `${to} already has a note named ${name}; merge the two or rename one first`,
      );
    // One more in the target namespace, none more in the account.
    await checkRoom(
      db,
      account_id,
      to,
      { namespaceNotes: 1, accountNotes: 0, bytes: 0 },
      owner,
    );
    const [note] = await decryptRows(account_id, rows);
    const encrypted = await encryptNote(
      account_id,
      to,
      name,
      note.description,
      note.body,
    );
    // A note promoted out of an agent's own scope is kept until deleted; one
    // moved into it gets that scope's default expiry if it had none.
    const ttl = agentOfMemoryNamespace(to)
      ? `COALESCE(ttl_seconds, ${AGENT_MEMORY_LIMITS.agentNoteDefaultTtlDays * DAY_SECONDS})`
      : agentOfMemoryNamespace(from)
        ? "NULL::int"
        : "ttl_seconds";
    // The ciphertexts are bound to the note's place, so they are rewritten.
    await db.query(
      `UPDATE agent_memory_notes SET namespace=$4, description=$5, body=$6,
              ttl_seconds=${ttl}, expires_at=now() + make_interval(secs => ${ttl})
        WHERE account_id=$1 AND namespace=$2 AND name=$3`,
      [account_id, from, name, to, encrypted.description, encrypted.body],
    );
  }

  function exportMarkdown(
    notes: AgentMemoryNote[],
    namespaces: AgentMemoryNamespace[],
    agents?: { agent_id: string; name: string | null }[],
  ) {
    return agentMemoryMarkdown({
      notes,
      namespaces,
      agents,
      exported_at: new Date().toISOString(),
    });
  }

  /** Agents with a scope in this account's memory, for the owner. */
  async function agentScopes(
    db: MemoryDb,
    account_id: string,
    counts?: Record<string, number>,
  ): Promise<{ agent_id: string; name: string | null; notes: number }[]> {
    const all = counts ?? (await namespaceCounts(db, account_id)).counts;
    const { rows } = await db.query(
      "SELECT agent_id, name FROM agent_memory_agents WHERE account_id=$1",
      [account_id],
    );
    const names = new Map<string, string>(
      rows.map((row) => [`${row.agent_id}`.toLowerCase(), row.name]),
    );
    const scopes: { agent_id: string; name: string | null; notes: number }[] =
      [];
    for (const [namespace, notes] of Object.entries(all)) {
      const agent_id = agentOfMemoryNamespace(namespace);
      if (agent_id)
        scopes.push({ agent_id, name: names.get(agent_id) ?? null, notes });
    }
    return scopes.sort((a, b) =>
      (a.name ?? a.agent_id).localeCompare(b.name ?? b.agent_id),
    );
  }

  async function namespaceCounts(
    db: MemoryDb,
    account_id: string,
    live = LIVE,
  ) {
    const { rows } = await db.query(
      `SELECT namespace, count(*)::int AS notes, coalesce(sum(bytes),0)::bigint AS bytes
         FROM agent_memory_notes WHERE account_id=$1 AND ${live} GROUP BY namespace`,
      [account_id],
    );
    const counts: Record<string, number> = {};
    let notes = 0;
    let bytes = 0;
    for (const row of rows) {
      counts[row.namespace] = Number(row.notes);
      notes += Number(row.notes);
      bytes += Number(row.bytes);
    }
    return { counts, notes, bytes };
  }

  /** A live note's authorship and content, or undefined. */
  async function liveNote(
    db: MemoryDb,
    account_id: string,
    namespace: string,
    name: string,
  ): Promise<
    (NoteRow & { body: string; namespace: string; name: string }) | undefined
  > {
    const { rows } = await db.query(
      `SELECT body, ${NOTE_COLUMNS} FROM agent_memory_notes
        WHERE account_id=$1 AND namespace=$2 AND name=$3 AND ${LIVE}`,
      [account_id, namespace, name],
    );
    return rows[0];
  }

  async function checkRevision(
    account_id: string,
    row: NoteRow & { body: string },
    expected: string,
    ref: string,
  ) {
    const [note] = await decryptRows(account_id, [row]);
    if (memoryRevision(note.description, note.body) !== expected)
      throw new Error(
        `memory note ${ref} changed since you read it; read it again and merge your change`,
      );
  }

  /** An agent by its name in this account: its Agents list, then memory. */
  async function agentByName(
    db: MemoryDb,
    account_id: string,
    name: string,
  ): Promise<string | undefined> {
    const { rows } = await db.query(
      `SELECT agent_id FROM agent_personal_names
        WHERE account_id=$1 AND name=$2 AND retired_at IS NULL`,
      [account_id, name],
    );
    if (rows[0]) return rows[0].agent_id;
    const { rows: known } = await db.query(
      `SELECT DISTINCT agent_id FROM agent_memory_agents
        WHERE account_id=$1 AND name=$2`,
      [account_id, name],
    );
    // Never guess between agents: each would expect @name to be its own.
    if (known.length > 1)
      throw new Error(
        `more than one agent is known as @${name} here; the account owner can give one of them its own name in Agents`,
      );
    return known[0]?.agent_id;
  }

  /**
   * A name for an agent the account does not list: its registration name,
   * made unique with part of its id if another agent already goes by it.
   */
  async function fallbackName(
    db: MemoryDb,
    account_id: string,
    agent: AgentMemoryCaller,
  ): Promise<string> {
    const base = agentNameFallback(agent.name);
    const suffix = agent.agent_id.replace(/-/g, "").slice(0, 8);
    const suffixed = `${base.slice(0, 23).replace(/-+$/, "")}-${suffix}`;
    const { rows: stored } = await db.query(
      "SELECT name FROM agent_memory_agents WHERE account_id=$1 AND agent_id=$2",
      [account_id, agent.agent_id],
    );
    // Once unique by its id, a name stays put, so references keep working.
    if (stored[0]?.name === suffixed) return suffixed;
    const { rows: taken } = await db.query(
      `SELECT 1 FROM agent_personal_names
        WHERE account_id=$1 AND name=$2 AND retired_at IS NULL AND agent_id<>$3
       UNION ALL
       SELECT 1 FROM agent_memory_agents
        WHERE account_id=$1 AND name=$2 AND agent_id<>$3
       LIMIT 1`,
      [account_id, base, agent.agent_id],
    );
    return taken.length ? suffixed : base;
  }

  /**
   * The calling agent as this account names it (so @name works as in its
   * Agents list), and a note that it had a turn: a scope whose agent has no
   * turn for long is deleted.
   */
  async function resolveCaller(
    account_id: string,
    agent: AgentMemoryCaller,
  ): Promise<AgentMemoryCaller> {
    if (!isValidUUID(agent.agent_id)) throw new Error("invalid agent");
    const db = pool();
    const { rows } = await db.query(
      `SELECT name FROM agent_personal_names
        WHERE account_id=$1 AND agent_id=$2 AND retired_at IS NULL LIMIT 1`,
      [account_id, agent.agent_id],
    );
    const agent_id = agent.agent_id.toLowerCase();
    const caller = {
      agent_id,
      name:
        rows[0]?.name ??
        (await fallbackName(db, account_id, { agent_id, name: agent.name })),
    };
    try {
      await db.query(
        `INSERT INTO agent_memory_agents (account_id, agent_id, name, last_turn_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (account_id, agent_id) DO UPDATE
           SET name=EXCLUDED.name, last_turn_at=now()
         WHERE agent_memory_agents.name <> EXCLUDED.name
            OR agent_memory_agents.last_turn_at < now() - interval '1 minute'`,
        [account_id, caller.agent_id, caller.name],
      );
    } catch (err) {
      // Only the inactivity sweep needs this; never fail a turn over it.
      logger.warn("unable to record agent memory activity", {
        account_id,
        err: `${err}`,
      });
    }
    return caller;
  }

  return {
    /**
     * An operation requested by an agent turn running as account_id in
     * project_id; caller is the registered agent, from its authenticated run.
     */
    async agent(
      account_id: string,
      project_id: string,
      request: AgentMemoryRequest,
      agent?: AgentMemoryCaller,
    ): Promise<unknown> {
      validateAgentMemoryRequest(request);
      if (!isValidUUID(project_id)) throw new Error("invalid project");
      const settings = await settingsOf(account_id);
      const writes =
        request.op === "write" ||
        request.op === "delete" ||
        request.op === "move";
      await deps.charge(
        account_id,
        writes ? "write" : "read",
        request.op === "write"
          ? memoryBytes(request.description) + memoryBytes(request.body)
          : 0,
      );
      if (!settings.enabled) throw new Error(AGENT_MEMORY_DISABLED);
      const caller = agent ? await resolveCaller(account_id, agent) : undefined;
      const own = caller ? agentMemoryNamespace(caller.agent_id) : undefined;
      const projectNamespaces = projectMemoryNamespaces(settings, project_id);
      // What this turn lists and searches: its own scope, then the shared
      // notes it sees.
      const visible = [
        ...(own ? [own] : []),
        GLOBAL,
        ...projectNamespaces.map((ns) => ns.name),
      ];
      const qualified = projectNamespaces.length > 0;
      const db = pool();
      // Changes recheck, under the account's lock, that memory is still on
      // and which namespaces the project sees now: the owner may have
      // detached one since this request began.
      const current = async (tx: MemoryDb) => {
        const now = await loadSettings(tx, account_id);
        if (!now?.enabled) throw new Error(AGENT_MEMORY_DISABLED);
        const namespaces = projectMemoryNamespaces(now, project_id);
        return {
          namespaces,
          visible: [
            ...(own ? [own] : []),
            GLOBAL,
            ...namespaces.map((ns) => ns.name),
          ],
        };
      };
      // Where a note named by this caller lives: an agent scope, or the
      // visible shared notes. Another agent's scope is read-only.
      const scope = async (
        tx: MemoryDb,
        ref: AgentMemoryRef,
      ): Promise<{ namespace: string; agent?: string } | undefined> => {
        if (ref.agent === undefined) return undefined;
        if (ref.agent === "self") {
          if (!own) throw noAgentScope();
          return { namespace: own };
        }
        if (caller && ref.agent === caller.name)
          return { namespace: own!, agent: ref.agent };
        const agent_id = await agentByName(tx, account_id, ref.agent);
        if (!agent_id)
          throw new Error(`no agent @${ref.agent} has memory notes here`);
        return { namespace: agentMemoryNamespace(agent_id), agent: ref.agent };
      };
      // Only the caller's own scope and shared notes are ever changed, and
      // memoryRef names the own scope agent/<name>.
      const shown = memoryRef;
      switch (request.op) {
        case "list": {
          let namespaces = visible;
          let label: string | undefined;
          if (request.namespace !== undefined) {
            const named = await listScope(db, request.namespace);
            namespaces = [named.namespace];
            label = named.agent;
          }
          const rows = await noteRows(db, account_id, namespaces);
          const notes = (await summaries(account_id, rows))
            .sort(
              (a, b) =>
                namespaces.indexOf(a.namespace) -
                  namespaces.indexOf(b.namespace) ||
                a.name.localeCompare(b.name),
            )
            .map(
              ({
                namespace,
                name,
                description,
                updated_at,
                last_read_at,
                written_by,
                expires_at,
              }) => ({
                name:
                  label && namespace !== own
                    ? `@${label}/${name}`
                    : memoryRef(namespace, name, qualified),
                namespace: agentOfMemoryNamespace(namespace)
                  ? namespace === own
                    ? AGENT_MEMORY_AGENT_SCOPE
                    : `@${label}`
                  : namespace,
                description,
                updated_at,
                last_read_at,
                ...(written_by ? { written_by } : {}),
                ...(expires_at ? { expires_at } : {}),
              }),
            );
          return { namespaces: projectNamespaces, notes };
        }
        case "read": {
          const ref = parseMemoryRef(request.name);
          const scoped = await scope(db, ref);
          const namespace =
            scoped?.namespace ??
            (await mustLocate(db, account_id, ref, visible));
          // Each read pushes a note's expiry out: a note in use stays.
          const { rows } = await db.query(
            `UPDATE agent_memory_notes SET last_read_at=now(), read_count=read_count+1,
                    expires_at=now() + make_interval(secs => ttl_seconds)
              WHERE account_id=$1 AND namespace=$2 AND name=$3 AND ${LIVE}
              RETURNING namespace, name, description, body, updated_at,
                        written_by_name, expires_at, attributed_at`,
            [account_id, namespace, ref.name],
          );
          if (!rows[0]) throw new Error(`no memory note named ${request.name}`);
          const [note] = await decryptRows(account_id, rows);
          return {
            ...note,
            name: scoped?.agent
              ? `@${scoped.agent}/${ref.name}`
              : memoryRef(namespace, ref.name, qualified),
            namespace: agentOfMemoryNamespace(namespace)
              ? scoped?.agent
                ? `@${scoped.agent}`
                : AGENT_MEMORY_AGENT_SCOPE
              : namespace,
            last_read_at: undefined,
            written_by: note.written_by ?? undefined,
            expires_at: note.expires_at ?? undefined,
            revision: memoryRevision(note.description, note.body),
          };
        }
        case "search": {
          const notes = await decryptRows(
            account_id,
            await noteRows(db, account_id, visible, true),
          );
          return {
            results: searchMemoryNotes(notes, request.query, {
              limit: request.limit,
              qualified,
            }).map((result) =>
              agentOfMemoryNamespace(result.namespace)
                ? { ...result, namespace: AGENT_MEMORY_AGENT_SCOPE }
                : result,
            ),
            searched: notes.length,
          };
        }
        case "namespaces": {
          const { counts } = await namespaceCounts(db, account_id);
          return {
            global_notes: counts[GLOBAL] ?? 0,
            ...(own
              ? {
                  agent_notes: counts[own] ?? 0,
                  agent_note_limit: AGENT_MEMORY_LIMITS.maxNotesPerAgent,
                }
              : {}),
            namespaces: projectNamespaces.map((ns) => ({
              ...ns,
              notes: counts[ns.name] ?? 0,
            })),
            default_namespace:
              projectNamespaces.length <= 1
                ? (projectNamespaces[0]?.name ?? GLOBAL)
                : undefined,
            // Whole-account usage is not shown: it would count notes in
            // namespaces this project does not see.
            limits: {
              account_notes: AGENT_MEMORY_LIMITS.maxNotes,
              namespace_notes: AGENT_MEMORY_LIMITS.maxNotesPerNamespace,
              description_bytes: AGENT_MEMORY_LIMITS.maxDescriptionBytes,
              body_bytes: AGENT_MEMORY_LIMITS.maxBodyBytes,
            },
          };
        }
        case "export": {
          const namespaces =
            request.namespace !== undefined
              ? [(await listScope(db, request.namespace)).namespace]
              : visible;
          const notes = await decryptRows(
            account_id,
            await noteRows(db, account_id, namespaces, true),
          );
          return {
            notes: notes.length,
            markdown: exportMarkdown(
              notes,
              projectNamespaces,
              await agentScopes(db, account_id),
            ),
          };
        }
        case "write": {
          const valid = validateMemoryWrite(request);
          const ttl =
            request.expires_in === undefined
              ? undefined
              : parseMemoryExpiry(request.expires_in);
          return await transaction(account_id, async (tx) => {
            const now = await current(tx);
            const fullNames = now.namespaces.length > 0;
            const scoped = await scope(tx, valid.ref);
            if (scoped?.agent && scoped.namespace !== own)
              throw readOnlyScope(scoped.agent);
            // An existing note is updated where it is; a new one goes to
            // the named namespace, or the project's default.
            const found = scoped
              ? (await liveNote(
                  tx,
                  account_id,
                  scoped.namespace,
                  valid.ref.name,
                ))
                ? scoped.namespace
                : undefined
              : await locate(
                  tx,
                  account_id,
                  valid.ref,
                  now.visible.filter((ns) => ns !== own),
                );
            const existing = found
              ? await liveNote(tx, account_id, found, valid.ref.name)
              : undefined;
            if (request.expected_revision !== undefined) {
              if (!existing)
                throw new Error(
                  `memory note ${request.name} no longer exists: it was deleted or moved since you read it`,
                );
              await checkRevision(
                account_id,
                existing,
                request.expected_revision,
                shown(found!, valid.ref.name, fullNames),
              );
            } else if (existing && writtenByOther(existing, caller))
              throw otherWriter(
                shown(found!, valid.ref.name, fullNames),
                existing,
                caller,
                "replace",
              );
            const namespace =
              found ??
              scoped?.namespace ??
              valid.ref.namespace ??
              defaultNamespace(now.namespaces);
            await deps.assertWritable(tx, account_id);
            const saved = await writeNote(
              tx,
              account_id,
              namespace,
              valid.ref.name,
              valid.description,
              valid.body,
              project_id,
              caller,
              ttl,
            );
            const { rows: after } = await tx.query(
              `SELECT expires_at FROM agent_memory_notes
                WHERE account_id=$1 AND namespace=$2 AND name=$3`,
              [account_id, namespace, valid.ref.name],
            );
            return {
              name: shown(namespace, valid.ref.name, fullNames),
              namespace:
                namespace === own ? AGENT_MEMORY_AGENT_SCOPE : namespace,
              saved,
              revision: memoryRevision(valid.description, valid.body),
              ...(after[0]?.expires_at
                ? { expires_at: iso(after[0].expires_at) }
                : {}),
            };
          });
        }
        case "delete": {
          const ref = parseMemoryRef(request.name);
          return await transaction(account_id, async (tx) => {
            const now = await current(tx);
            const scoped = await scope(tx, ref);
            if (scoped?.agent && scoped.namespace !== own)
              throw readOnlyScope(scoped.agent);
            // A missing note is an error, as for read and move, so it is
            // not mistaken for a deletion.
            const namespace =
              scoped?.namespace ??
              (await mustLocate(
                tx,
                account_id,
                ref,
                now.visible.filter((ns) => ns !== own),
              ));
            const existing = await liveNote(
              tx,
              account_id,
              namespace,
              ref.name,
            );
            const fullNames = now.namespaces.length > 0;
            if (!existing)
              throw new Error(`no memory note named ${request.name}`);
            if (request.expected_revision !== undefined)
              await checkRevision(
                account_id,
                existing,
                request.expected_revision,
                shown(namespace, ref.name, fullNames),
              );
            else if (writtenByOther(existing, caller))
              throw otherWriter(
                shown(namespace, ref.name, fullNames),
                existing,
                caller,
                "delete",
              );
            await deps.assertWritable(tx, account_id);
            await tx.query(
              "DELETE FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2 AND name=$3",
              [account_id, namespace, ref.name],
            );
            return {
              name: shown(namespace, ref.name, fullNames),
              namespace:
                namespace === own ? AGENT_MEMORY_AGENT_SCOPE : namespace,
              deleted: true,
            };
          });
        }
        case "move": {
          const ref = parseMemoryRef(request.name);
          return await transaction(account_id, async (tx) => {
            const now = await current(tx);
            let to: string;
            if (request.to === AGENT_MEMORY_AGENT_SCOPE) {
              if (!own) throw noAgentScope();
              to = own;
            } else {
              to = validateMemoryNamespace(request.to);
              if (!now.visible.includes(to)) throw notAvailable(to);
            }
            const scoped = await scope(tx, ref);
            if (scoped?.agent && scoped.namespace !== own)
              throw readOnlyScope(scoped.agent);
            const from =
              scoped?.namespace ??
              (await mustLocate(
                tx,
                account_id,
                ref,
                now.visible.filter((ns) => ns !== own),
              ));
            const fullNames = now.namespaces.length > 0;
            const existing = await liveNote(tx, account_id, from, ref.name);
            if (existing && request.expected_revision !== undefined)
              await checkRevision(
                account_id,
                existing,
                request.expected_revision,
                shown(from, ref.name, fullNames),
              );
            else if (existing && writtenByOther(existing, caller))
              throw otherWriter(
                shown(from, ref.name, fullNames),
                existing,
                caller,
                "move",
              );
            await deps.assertWritable(tx, account_id);
            await moveNote(tx, account_id, from, ref.name, to, false);
            return {
              name: shown(to, ref.name, fullNames),
              from: from === own ? AGENT_MEMORY_AGENT_SCOPE : from,
              to: to === own ? AGENT_MEMORY_AGENT_SCOPE : to,
            };
          });
        }
      }

      // The scope a list or export names: a shared namespace this project
      // sees, the caller's own scope (`agent`) or another agent's (`@name`).
      async function listScope(
        tx: MemoryDb,
        name: string,
      ): Promise<{ namespace: string; agent?: string }> {
        if (name === AGENT_MEMORY_AGENT_SCOPE) {
          if (!own) throw noAgentScope();
          return { namespace: own };
        }
        if (name.startsWith("@")) {
          const scoped = await scope(tx, { name: "x", agent: name.slice(1) });
          return scoped!;
        }
        if (!visible.includes(name)) throw notAvailable(name);
        return { namespace: name };
      }
    },

    /** The list a turn in this project starts with; undefined when memory is off. */
    async turnIndex(
      account_id: string,
      project_id: string,
      agent?: AgentMemoryCaller,
    ): Promise<{ notes: number; index: string } | undefined> {
      const settings = await settingsOf(account_id);
      if (!settings.enabled) return undefined;
      await deps.charge(account_id, "read");
      const caller = agent ? await resolveCaller(account_id, agent) : undefined;
      const projectNamespaces = projectMemoryNamespaces(settings, project_id);
      const visible = [
        ...(caller ? [agentMemoryNamespace(caller.agent_id)] : []),
        GLOBAL,
        ...projectNamespaces.map((ns) => ns.name),
      ];
      const db = pool();
      const rows = await noteRows(db, account_id, visible);
      const ranked = rankMemoryNotes(
        rows.map((row) => ({
          ...row,
          updated_at: iso(row.updated_at)!,
          last_read_at: iso(row.last_read_at),
        })),
        project_id,
      ).slice(0, INDEX_CANDIDATES);
      const notes = await Promise.all(
        ranked.map(async (row) => ({
          ...row,
          description: await decryptField(
            account_id,
            row,
            "description",
            row.description,
          ),
          written_by: writer(row),
        })),
      );
      // Only what this project sees: nothing about other namespaces.
      const counts: Record<string, number> = Object.fromEntries(
        visible.map((ns) => [ns, 0]),
      );
      for (const row of rows) counts[row.namespace] += 1;
      return {
        notes: rows.length,
        index: buildMemoryIndex({
          notes,
          total: rows.length,
          namespaces: projectNamespaces,
          counts,
          agent: caller,
        }),
      };
    },

    /** The account removed this agent from its Agents: delete its scope. */
    async agentRetired(
      account_id: string,
      agent_id: string,
    ): Promise<{ deleted: number }> {
      const namespace = agentMemoryNamespace(agent_id);
      return await transaction(account_id, async (tx) => {
        await deps.assertWritable(tx, account_id);
        const { rowCount } = await tx.query(
          "DELETE FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2",
          [account_id, namespace],
        );
        await tx.query(
          "DELETE FROM agent_memory_agents WHERE account_id=$1 AND agent_id=$2",
          [account_id, agent_id.toLowerCase()],
        );
        return { deleted: rowCount ?? 0 };
      });
    },

    /**
     * Deletes expired notes and the scopes of agents that had no turn for
     * agentInactiveDays, in bounded batches. Runs on each bay over the
     * memory it keeps (that of accounts homed there).
     */
    async sweep({ batch = 1000 }: { batch?: number } = {}): Promise<{
      expired: number;
      inactive_agents: number;
      inactive_notes: number;
    }> {
      const db = pool();
      const { rowCount: expired } = await db.query(
        `DELETE FROM agent_memory_notes WHERE ctid IN (
           SELECT ctid FROM agent_memory_notes
            WHERE expires_at IS NOT NULL AND expires_at <= now() AND ${ATTRIBUTED}
              -- Turning memory off pauses expiry.
              AND account_id IN
                (SELECT account_id FROM agent_memory_accounts WHERE enabled)
            LIMIT $1)`,
        [batch],
      );
      const { rows: idle } = await db.query(
        `SELECT g.account_id, g.agent_id FROM agent_memory_agents g
           JOIN agent_memory_accounts a ON a.account_id=g.account_id AND a.enabled
          WHERE g.last_turn_at < now() - make_interval(days => $1::int)
          ORDER BY g.last_turn_at LIMIT $2`,
        [AGENT_MEMORY_LIMITS.agentInactiveDays, batch],
      );
      let inactive_notes = 0;
      for (const { account_id, agent_id } of idle) {
        inactive_notes += await transaction(account_id, async (tx) => {
          // Only if no turn came meanwhile: a turn records itself first.
          const { rows: gone } = await tx.query(
            `DELETE FROM agent_memory_agents
              WHERE account_id=$1 AND agent_id=$2
                AND last_turn_at < now() - make_interval(days => $3::int)
              RETURNING agent_id`,
            [account_id, agent_id, AGENT_MEMORY_LIMITS.agentInactiveDays],
          );
          if (!gone.length) return 0;
          const { rowCount } = await tx.query(
            "DELETE FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2",
            [account_id, agentMemoryNamespace(agent_id)],
          );
          return rowCount ?? 0;
        });
      }
      return {
        expired: expired ?? 0,
        inactive_agents: idle.length,
        inactive_notes,
      };
    },

    /** The account owner's settings page. Never charged. */
    async owner(
      account_id: string,
      request: AgentMemoryOwnerRequest,
    ): Promise<any> {
      validateAgentMemoryOwnerRequest(request);
      const db = pool();
      switch (request.op) {
        case "status": {
          const settings = await settingsOf(account_id);
          const all = await namespaceCounts(
            db,
            account_id,
            ownerLive(settings.enabled),
          );
          const { rows } = await db.query(
            "SELECT max(updated_at) AS updated_at FROM agent_memory_notes WHERE account_id=$1",
            [account_id],
          );
          const status: AgentMemoryStatus = {
            enabled: settings.enabled,
            notes: all.notes,
            bytes: all.bytes,
            updated_at: iso(rows[0]?.updated_at) ?? undefined,
            global_notes: all.counts[GLOBAL] ?? 0,
            namespaces: settings.namespaces.map((ns) => ({
              ...ns,
              notes: all.counts[ns.name] ?? 0,
            })),
            agents: await agentScopes(db, account_id, all.counts),
            projects: settings.projects,
            limits: AGENT_MEMORY_LIMITS,
          };
          return status;
        }
        case "list": {
          const settings = await settingsOf(account_id);
          return {
            notes_list: await summaries(
              account_id,
              await noteRows(
                db,
                account_id,
                undefined,
                false,
                ownerLive(settings.enabled),
              ),
            ),
          };
        }
        case "read": {
          const settings = await settingsOf(account_id);
          // Like an agent's read: an expired note is gone, and reading one
          // keeps it (while memory is off, nothing expires).
          const { rows } = await db.query(
            `UPDATE agent_memory_notes
                SET expires_at = CASE WHEN $4::boolean
                  THEN now() + make_interval(secs => ttl_seconds)
                  ELSE expires_at END
              WHERE account_id=$1 AND namespace=$2 AND name=$3
                AND ${ownerLive(settings.enabled)}
              RETURNING namespace, name, description, body, updated_at,
                        last_read_at, written_by_name, expires_at, attributed_at`,
            [account_id, request.namespace, request.name, settings.enabled],
          );
          if (!rows[0])
            throw new Error(
              `no memory note named ${memoryRef(request.namespace, request.name, true)}`,
            );
          return (await decryptRows(account_id, rows))[0];
        }
        case "export": {
          const settings = await settingsOf(account_id);
          const notes = await decryptRows(
            account_id,
            await noteRows(
              db,
              account_id,
              request.namespace ? [request.namespace] : undefined,
              true,
              ownerLive(settings.enabled),
            ),
          );
          return {
            notes: notes.length,
            markdown: exportMarkdown(
              notes,
              settings.namespaces,
              await agentScopes(db, account_id),
            ),
          };
        }
      }
      await settingsOf(account_id);
      return await transaction(account_id, async (tx) => {
        await deps.assertWritable(tx, account_id);
        const settings = await settingsForUpdate(tx, account_id);
        const exists = (ns: string) =>
          ns === GLOBAL || settings.namespaces.some((n) => n.name === ns);
        switch (request.op) {
          case "set-enabled":
            if (request.enabled && !settings.enabled) {
              // Expiry and inactivity were paused while memory was off:
              // their clocks start again now.
              await tx.query(
                `UPDATE agent_memory_notes
                    SET expires_at = now() + make_interval(secs => ttl_seconds)
                  WHERE account_id=$1 AND ttl_seconds IS NOT NULL AND ${ATTRIBUTED}`,
                [account_id],
              );
              await tx.query(
                "UPDATE agent_memory_agents SET last_turn_at=now() WHERE account_id=$1",
                [account_id],
              );
            }
            await saveSettings(tx, account_id, {
              ...settings,
              enabled: request.enabled,
            });
            return { enabled: request.enabled };
          case "delete": {
            const namespace = request.namespace ?? GLOBAL;
            const { rowCount } = await tx.query(
              "DELETE FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2 AND name=$3",
              [account_id, namespace, request.name],
            );
            return { name: request.name, namespace, deleted: !!rowCount };
          }
          case "delete-all": {
            const { rowCount } = await tx.query(
              "DELETE FROM agent_memory_notes WHERE account_id=$1",
              [account_id],
            );
            await tx.query(
              "DELETE FROM agent_memory_agents WHERE account_id=$1",
              [account_id],
            );
            await deps.legacy.remove(account_id, tx);
            return { deleted: rowCount ?? 0 };
          }
          case "move": {
            if (!exists(request.to))
              throw new Error(`no memory namespace named ${request.to}`);
            await moveNote(
              tx,
              account_id,
              request.namespace,
              request.name,
              request.to,
              true,
            );
            return {
              name: request.name,
              from: request.namespace,
              to: request.to,
            };
          }
          case "namespace-save": {
            const description = validateMemoryNamespaceDescription(
              request.description,
            );
            const namespaces = settings.namespaces.filter(
              (ns) => ns.name !== request.name,
            );
            if (namespaces.length >= AGENT_MEMORY_LIMITS.maxNamespaces)
              throw new Error(
                `agent memory can have at most ${AGENT_MEMORY_LIMITS.maxNamespaces} namespaces`,
              );
            const saved = description
              ? { name: request.name, description }
              : { name: request.name };
            const index = settings.namespaces.findIndex(
              (ns) => ns.name === request.name,
            );
            if (index >= 0) settings.namespaces[index] = saved;
            else settings.namespaces.push(saved);
            await saveSettings(tx, account_id, settings);
            return { namespace: saved, created: index < 0 };
          }
          case "namespace-delete": {
            const { rowCount } = await tx.query(
              "DELETE FROM agent_memory_notes WHERE account_id=$1 AND namespace=$2",
              [account_id, request.name],
            );
            settings.namespaces = settings.namespaces.filter(
              (ns) => ns.name !== request.name,
            );
            for (const [project_id, list] of Object.entries(
              settings.projects,
            )) {
              const kept = list.filter((ns) => ns !== request.name);
              if (kept.length) settings.projects[project_id] = kept;
              else delete settings.projects[project_id];
            }
            await saveSettings(tx, account_id, settings);
            return { deleted_notes: rowCount ?? 0 };
          }
          case "set-project-namespaces": {
            for (const ns of request.namespaces)
              if (!exists(ns))
                throw new Error(`no memory namespace named ${ns}`);
            if (request.namespaces.length) {
              if (
                !settings.projects[request.project_id] &&
                Object.keys(settings.projects).length >=
                  AGENT_MEMORY_LIMITS.maxProjects
              )
                throw new Error(
                  `at most ${AGENT_MEMORY_LIMITS.maxProjects} projects can have memory namespaces`,
                );
              settings.projects[request.project_id] = [...request.namespaces];
            } else delete settings.projects[request.project_id];
            await saveSettings(tx, account_id, settings);
            return {
              project_id: request.project_id,
              namespaces: request.namespaces,
            };
          }
        }
        throw new Error("unsupported agent memory operation");
      });
    },
  };
}

let singleton: ReturnType<typeof createAgentMemory> | undefined;
export function agentMemory() {
  return (singleton ??= createAgentMemory());
}
