/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { CollaborationSource } from "./journal";

export interface CollaborationActivityPage {
  epoch: string;
  resources: Pick<CollaborationResource, "kind" | "resource_id" | "activity">[];
  next?: string;
}
export type ActivitySource = CollaborationSource & { epoch: string };

/** Uses the source journal transaction; no independent commits or clock-based activity. */
export class SourceActivity {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_imports (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, epoch TEXT NOT NULL,
        cursor TEXT, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,chat_path));
      CREATE TABLE IF NOT EXISTS activity_totals (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, kind TEXT NOT NULL,
        resource_id TEXT NOT NULL, activity INTEGER NOT NULL, initialized INTEGER NOT NULL,
        PRIMARY KEY(project_id,chat_path,kind,resource_id));
    `);
  }
  recovery(source: ActivitySource): { complete: boolean; after?: string } {
    const row = this.db
      .prepare(
        "SELECT * FROM activity_imports WHERE project_id=? AND chat_path=? AND epoch=?",
      )
      .get(source.project_id, source.chat_path, source.epoch);
    return {
      complete: row?.complete === 1,
      ...(row?.cursor ? { after: String(row.cursor) } : {}),
    };
  }
  restart(source: ActivitySource) {
    this.db
      .prepare(
        "DELETE FROM activity_imports WHERE project_id=? AND chat_path=? AND epoch=? AND complete=0",
      )
      .run(source.project_id, source.chat_path, source.epoch);
  }
  importPage(source: ActivitySource, page: CollaborationActivityPage) {
    if (
      page.epoch !== source.epoch ||
      !Array.isArray(page.resources) ||
      page.resources.length > 100 ||
      (page.next !== undefined &&
        (typeof page.next !== "string" ||
          !page.next ||
          page.next.length > 4096 ||
          page.next === this.recovery(source).after))
    )
      throw Error("invalid epoch-fenced collaboration activity page");
    for (const item of page.resources) {
      if (
        !["conversation", "agent", "artifact"].includes(item.kind) ||
        typeof item.resource_id !== "string" ||
        !item.resource_id ||
        item.resource_id.length > 256 ||
        !Number.isSafeInteger(item.activity) ||
        item.activity < 0
      )
        throw Error("invalid collaboration activity floor");
      this.db
        .prepare(
          `INSERT INTO activity_totals VALUES(?,?,?,?,?,0)
        ON CONFLICT(project_id,chat_path,kind,resource_id) DO UPDATE SET
        initialized=CASE WHEN excluded.activity>activity_totals.activity THEN 0 ELSE activity_totals.initialized END,
        activity=MAX(activity_totals.activity,excluded.activity)`,
        )
        .run(
          source.project_id,
          source.chat_path,
          item.kind,
          item.resource_id,
          item.activity,
        );
    }
    this.assertCapacity();
    this.db
      .prepare(
        "INSERT INTO activity_imports VALUES(?,?,?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor,complete=excluded.complete",
      )
      .run(
        source.project_id,
        source.chat_path,
        source.epoch,
        page.next ?? null,
        page.next ? 0 : 1,
      );
  }
  advance(
    source: CollaborationSource,
    resource: CollaborationResource,
    seen: Set<string>,
    incoming: string[],
  ): { activity: number; positions: Map<string, number> } {
    const row = this.db
      .prepare(
        "SELECT activity,initialized FROM activity_totals WHERE project_id=? AND chat_path=? AND kind=? AND resource_id=?",
      )
      .get(
        source.project_id,
        source.chat_path,
        resource.kind,
        resource.resource_id,
      );
    let activity = Math.max(Number(row?.activity ?? 0), seen.size);
    const baseline = row?.initialized === 0 && Number(row.activity) > seen.size;
    const positions = new Map<string, number>();
    for (const id of [...incoming].sort()) {
      if (typeof id !== "string" || !id || id.length > 200)
        throw Error("invalid activity identity");
      if (!seen.has(id)) {
        seen.add(id);
        if (!baseline) positions.set(id, ++activity);
      }
      if (seen.size > 100_000)
        throw Error("collaboration activity capacity exceeded");
    }
    if (baseline) activity = Math.max(activity, seen.size);
    if (!Number.isSafeInteger(activity))
      throw Error("collaboration activity exhausted");
    this.db
      .prepare(
        "INSERT INTO activity_totals VALUES(?,?,?,?,?,1) ON CONFLICT(project_id,chat_path,kind,resource_id) DO UPDATE SET activity=excluded.activity,initialized=1",
      )
      .run(
        source.project_id,
        source.chat_path,
        resource.kind,
        resource.resource_id,
        activity,
      );
    return { activity, positions };
  }
  floor(source: CollaborationSource, resource: CollaborationResource): number {
    return Number(
      this.db
        .prepare(
          "SELECT activity FROM activity_totals WHERE project_id=? AND chat_path=? AND kind=? AND resource_id=?",
        )
        .get(
          source.project_id,
          source.chat_path,
          resource.kind,
          resource.resource_id,
        )?.activity ?? 0,
    );
  }
  assertCapacity() {
    if (
      Number(
        this.db.prepare("SELECT count(*) AS n FROM activity_totals").get()!.n,
      ) > 100_000
    )
      throw Error("collaboration activity checkpoint capacity exceeded");
  }
  get bytes(): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(length(CAST(resource_id AS BLOB))+length(kind)+8),0) AS n FROM activity_totals",
        )
        .get()!.n,
    );
  }
  relocate(
    project_id: string,
    from_path: string,
    to_path: string,
    epoch?: string,
  ) {
    this.db
      .prepare("DELETE FROM activity_totals WHERE project_id=? AND chat_path=?")
      .run(project_id, to_path);
    this.db
      .prepare(
        "UPDATE activity_totals SET chat_path=? WHERE project_id=? AND chat_path=?",
      )
      .run(to_path, project_id, from_path);
    this.db
      .prepare(
        "DELETE FROM activity_imports WHERE project_id=? AND chat_path IN (?,?)",
      )
      .run(project_id, from_path, to_path);
    if (epoch)
      this.db
        .prepare("INSERT INTO activity_imports VALUES(?,?,?,NULL,1)")
        .run(project_id, to_path, epoch);
  }
}
