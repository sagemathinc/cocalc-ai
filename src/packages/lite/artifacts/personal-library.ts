/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { chmodSync, closeSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  PersonalLibraryApi,
  PersonalLibrarySnapshot,
} from "@cocalc/conat/hub/api/personal-library";
import {
  PERSONAL_LIBRARY_MAX_PIN_BYTES,
  PERSONAL_LIBRARY_MAX_PINS,
  movePersonalLibraryPin,
  normalizePersonalLibraryName,
  parsePersonalLibraryPinKey,
  validatePersonalLibraryPinKey,
  validatePersonalLibraryTarget,
} from "@cocalc/util/personal-library";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";

export class LitePersonalLibrary implements PersonalLibraryApi {
  private readonly db: DatabaseSync;

  constructor(
    private readonly options: {
      filename: string;
      account_id: string;
      project_id: string;
      artifactExists: (projectId: string, entryId: string) => Promise<boolean>;
    },
  ) {
    if (options.filename !== ":memory:") {
      const fd = openSync(options.filename, "a", 0o600);
      closeSync(fd);
      chmodSync(options.filename, 0o600);
    }
    this.db = new DatabaseSync(options.filename);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS personal_library_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL, project_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_library_aliases (
        name TEXT PRIMARY KEY, project_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS personal_library_current_target
        ON personal_library_aliases(project_id,entry_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS personal_library_pins (
        pin_key TEXT PRIMARY KEY, rank INTEGER NOT NULL
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO personal_library_owner VALUES(1,?,?)")
      .run(options.account_id, options.project_id);
    const owner = this.db
      .prepare(
        "SELECT account_id,project_id FROM personal_library_owner WHERE singleton=1",
      )
      .get();
    if (
      owner?.account_id !== options.account_id ||
      owner?.project_id !== options.project_id
    ) {
      this.db.close();
      throw Error("Personal library belongs to another account or project");
    }
  }

  close() {
    this.db.close();
  }

  private assertAccount(accountId?: string) {
    if (accountId !== this.options.account_id)
      throw Error("Personal library account unavailable");
  }

  private snapshot(): PersonalLibrarySnapshot {
    const aliases = this.db
      .prepare(
        "SELECT name,project_id,entry_id,active FROM personal_library_aliases ORDER BY name",
      )
      .all()
      .map((row) => ({
        name: row.name as string,
        project_id: row.project_id as string,
        entry_id: row.entry_id as string,
        active: row.active === 1,
      }));
    const pins = this.db
      .prepare(
        "SELECT pin_key FROM personal_library_pins ORDER BY rank,pin_key",
      )
      .all()
      .map((row) => row.pin_key as string);
    return { aliases, pins };
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private replacePins(pins: string[]) {
    for (let rank = 0; rank < pins.length; rank++)
      this.db
        .prepare("UPDATE personal_library_pins SET rank=? WHERE pin_key=?")
        .run(rank, pins[rank]);
  }

  async list(
    opts: Parameters<PersonalLibraryApi["list"]>[0],
  ): Promise<PersonalLibrarySnapshot> {
    this.assertAccount(opts.account_id);
    return this.snapshot();
  }

  async resolve(opts: Parameters<PersonalLibraryApi["resolve"]>[0]) {
    this.assertAccount(opts.account_id);
    const name = normalizePersonalLibraryName(opts.name);
    return this.snapshot().aliases.find((alias) => alias.name === name) ?? null;
  }

  async name(
    opts: Parameters<PersonalLibraryApi["name"]>[0],
  ): Promise<PersonalLibrarySnapshot> {
    this.assertAccount(opts.account_id);
    validatePersonalLibraryTarget(opts);
    if (
      opts.project_id !== this.options.project_id ||
      !(await this.options.artifactExists(opts.project_id, opts.entry_id))
    )
      throw Error("Artifact unavailable");
    const name = normalizePersonalLibraryName(opts.name);
    return this.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT project_id,entry_id FROM personal_library_aliases WHERE name=?",
        )
        .get(name);
      if (
        current &&
        (current.project_id !== opts.project_id ||
          current.entry_id !== opts.entry_id)
      )
        throw Error(`@${name} is already used by another artifact`);
      if (!current && this.snapshot().aliases.length >= 1000)
        throw Error("Artifact name limit reached");
      this.db
        .prepare(
          "UPDATE personal_library_aliases SET active=0 WHERE project_id=? AND entry_id=? AND active=1",
        )
        .run(opts.project_id, opts.entry_id);
      this.db
        .prepare(
          "INSERT INTO personal_library_aliases(name,project_id,entry_id,active) VALUES(?,?,?,1) ON CONFLICT(name) DO UPDATE SET active=1",
        )
        .run(name, opts.project_id, opts.entry_id);
      return this.snapshot();
    });
  }

  async setPinned(
    opts: Parameters<PersonalLibraryApi["setPinned"]>[0],
  ): Promise<PersonalLibrarySnapshot> {
    this.assertAccount(opts.account_id);
    const key = validatePersonalLibraryPinKey(opts.pin_key);
    const locator = parsePersonalLibraryPinKey(key);
    if (
      locator.project_id !== this.options.project_id ||
      typeof opts.pinned !== "boolean"
    )
      throw Error("Invalid artifact pin");
    if (
      opts.pinned &&
      !(await this.options.artifactExists(
        locator.project_id,
        createHash("sha256")
          .update(artifactCatalogKey(locator, locator))
          .digest("hex"),
      ))
    )
      throw Error("Artifact unavailable");
    return this.transaction(() => {
      const pins = this.snapshot().pins.filter((pin) => pin !== key);
      if (opts.pinned) pins.push(key);
      if (
        pins.length > PERSONAL_LIBRARY_MAX_PINS ||
        pins.reduce((bytes, pin) => bytes + Buffer.byteLength(pin), 0) >
          PERSONAL_LIBRARY_MAX_PIN_BYTES
      )
        throw Error("Artifact pin limit reached");
      if (opts.pinned)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO personal_library_pins(pin_key,rank) VALUES(?,?)",
          )
          .run(key, pins.length - 1);
      else
        this.db
          .prepare("DELETE FROM personal_library_pins WHERE pin_key=?")
          .run(key);
      this.replacePins(pins);
      return this.snapshot();
    });
  }

  async movePinned(
    opts: Parameters<PersonalLibraryApi["movePinned"]>[0],
  ): Promise<PersonalLibrarySnapshot> {
    this.assertAccount(opts.account_id);
    const key = validatePersonalLibraryPinKey(opts.pin_key);
    if (
      !Array.isArray(opts.visible) ||
      opts.visible.length > PERSONAL_LIBRARY_MAX_PINS ||
      !Number.isInteger(opts.index)
    )
      throw Error("Invalid artifact pin order");
    const visible = opts.visible.map(validatePersonalLibraryPinKey);
    if (
      visible.reduce((bytes, pin) => bytes + Buffer.byteLength(pin), 0) >
      PERSONAL_LIBRARY_MAX_PIN_BYTES
    )
      throw Error("Invalid pin order");
    return this.transaction(() => {
      this.replacePins(
        movePersonalLibraryPin(this.snapshot().pins, visible, key, opts.index),
      );
      return this.snapshot();
    });
  }
}
