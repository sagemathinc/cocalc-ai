/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PersonalLibraryApi } from "@cocalc/conat/hub/api/personal-library";
import type { ClearArtifactAlias } from "./library-store";
import type {
  CollaborationPersonalState,
  CollaborationResource,
} from "@cocalc/util/collaborators";
import {
  normalizePersonalLibraryName,
  PERSONAL_LIBRARY_MAX_PINS,
  validatePersonalLibraryPinKey,
} from "@cocalc/util/personal-library";

export function artifactPin(resource: CollaborationResource): string {
  if (!resource.artifact_id) throw Error("Artifact has no native identity");
  return JSON.stringify([
    resource.project_id,
    resource.chat_path,
    resource.thread_id,
    resource.artifact_id,
  ]);
}

/** Library remains authoritative; these rows are only a bounded query projection. */
export class LibraryCompatibility {
  private snapshotHash?: string;
  private projectedRevision = -1;
  constructor(
    private readonly options: {
      db: DatabaseSync;
      account_id: string;
      project_id: string;
      api?: () => PersonalLibraryApi;
      clearAlias?: ClearArtifactAlias;
      revision: () => number;
      transaction: <T>(run: () => T) => T;
      changed: () => void;
      indexSearch: (key: string, title: string) => void;
    },
  ) {}

  async refresh(): Promise<void> {
    if (!this.options.api) return;
    const snapshot = await this.options
      .api()
      .list({ account_id: this.options.account_id });
    if (
      !Array.isArray(snapshot.aliases) ||
      snapshot.aliases.length > 1000 ||
      !Array.isArray(snapshot.pins) ||
      snapshot.pins.length > PERSONAL_LIBRARY_MAX_PINS ||
      Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024
    )
      throw Error("Library personal-state projection exceeds capacity");
    const hash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    if (
      hash === this.snapshotHash &&
      this.projectedRevision === this.options.revision()
    )
      return;
    this.options.transaction(() => {
      const { db } = this.options;
      const desired = new Map<string, { alias?: string; collected: boolean }>();
      const byEntry = db.prepare(
        "SELECT resource_key FROM collaboration_resources WHERE kind='artifact' AND deleted=0 AND json_extract(metadata,'$.entry_id')=? LIMIT 2",
      );
      const byPin = db.prepare(
        "SELECT resource_key FROM collaboration_resources WHERE kind='artifact' AND deleted=0 AND json_array(json_extract(metadata,'$.project_id'),chat_path,json_extract(metadata,'$.thread_id'),json_extract(metadata,'$.artifact_id'))=? LIMIT 2",
      );
      const add = (
        rows: ReturnType<typeof byEntry.all>,
        patch: { alias?: string; collected?: boolean },
      ) => {
        if (rows.length > 1) throw Error("ambiguous Library artifact identity");
        if (!rows.length) return;
        const key = rows[0].resource_key as string;
        desired.set(key, { collected: false, ...desired.get(key), ...patch });
      };
      for (const alias of snapshot.aliases) {
        if (!alias.active || alias.project_id !== this.options.project_id)
          continue;
        add(byEntry.all(alias.entry_id), {
          alias: normalizePersonalLibraryName(alias.name),
        });
      }
      for (const pin of snapshot.pins)
        add(byPin.all(validatePersonalLibraryPinKey(pin)), { collected: true });
      const previous = db
        .prepare(
          "SELECT resource_key,alias,collected FROM collaboration_personal WHERE kind='artifact' AND (alias IS NOT NULL OR collected=1)",
        )
        .all();
      const old = new Map(
        previous.map((row) => [
          row.resource_key as string,
          {
            ...(row.alias ? { alias: row.alias as string } : {}),
            collected: row.collected === 1,
          },
        ]),
      );
      const encode = (entries: typeof old) =>
        JSON.stringify(
          [...entries]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, value.alias ?? null, value.collected]),
        );
      if (encode(old) !== encode(desired)) {
        const clear = db.prepare(
          "UPDATE collaboration_personal SET alias=NULL,collected=0 WHERE resource_key=?",
        );
        for (const key of old.keys()) clear.run(key);
        const upsert =
          db.prepare(`INSERT INTO collaboration_personal(resource_key,kind,alias,collected) VALUES(?,'artifact',?,?)
          ON CONFLICT(resource_key) DO UPDATE SET alias=excluded.alias,collected=excluded.collected`);
        for (const [key, state] of desired)
          upsert.run(key, state.alias ?? null, +state.collected);
        const title = db.prepare(
          "SELECT json_extract(metadata,'$.title') AS title FROM collaboration_resources WHERE resource_key=? AND deleted=0",
        );
        for (const key of new Set([...old.keys(), ...desired.keys()])) {
          const row = title.get(key);
          if (row) this.options.indexSearch(key, row.title as string);
        }
        this.options.changed();
      }
      this.snapshotHash = hash;
      this.projectedRevision = this.options.revision();
    });
  }

  async write(
    resource: CollaborationResource,
    patch: Partial<CollaborationPersonalState>,
  ): Promise<void> {
    if (patch.alias === undefined && patch.collected === undefined) return;
    if (!this.options.api)
      throw Error("Lite Library personal-state adapter is unavailable");
    if (patch.alias !== undefined) {
      if (patch.alias) normalizePersonalLibraryName(patch.alias);
      else if (!this.options.clearAlias)
        throw Error("Lite Library alias removal adapter is unavailable");
      if (!resource.entry_id)
        throw Error("Artifact has no verified catalog entry");
    }
    if (patch.collected !== undefined)
      validatePersonalLibraryPinKey(artifactPin(resource));
    const api = this.options.api();
    if (patch.alias !== undefined) {
      const target = {
        account_id: this.options.account_id,
        project_id: resource.project_id,
        entry_id: resource.entry_id!,
      };
      if (patch.alias) await api.name({ ...target, name: patch.alias });
      else await this.options.clearAlias!(target);
    }
    if (patch.collected !== undefined)
      await api.setPinned({
        account_id: this.options.account_id,
        pin_key: artifactPin(resource),
        pinned: patch.collected,
      });
    await this.refresh();
  }
}
