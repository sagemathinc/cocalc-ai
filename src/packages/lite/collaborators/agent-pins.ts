/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import { getDatabase, getRow, upsertRow } from "../hub/sqlite/database";

const SETTING = "experimental_my_agents_organization_v1";
export interface LiteAgentPins {
  read(): string[];
  set(agent_id: string, collected: boolean): void;
}

function pins(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value)
          .filter(([key]) => /^\d+$/.test(key))
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, id]) => id)
      : [];
  const result = [
    ...new Set(values.filter((id): id is string => typeof id === "string")),
  ];
  if (result.length > 500) throw Error("Agent pin limit reached");
  return result;
}

/** Same account-home preference as the existing Agents workspace, never a new identity. */
export function liteAgentPins(account_id: string): LiteAgentPins {
  const pk = JSON.stringify({ account_id });
  return {
    read: () => pins(getRow("accounts", pk)?.other_settings?.[SETTING]?.pinned),
    set(agent_id, collected) {
      const db = getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = getRow("accounts", pk);
        if (!row || row.account_id !== account_id)
          throw Error("local Lite account is unavailable");
        const other_settings = row.other_settings ?? {};
        const raw = other_settings[SETTING];
        const organization =
          raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const current = pins(organization.pinned).filter(
          (id) => id !== agent_id,
        );
        if (collected) {
          if (current.length >= 500) throw Error("Agent pin limit reached");
          current.push(agent_id);
        }
        upsertRow("accounts", pk, {
          ...row,
          other_settings: {
            ...other_settings,
            [SETTING]: { ...organization, pinned: JSON.stringify(current) },
          },
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export class AgentPinCompatibility {
  private signature?: string;
  private revision = -1;
  constructor(
    private readonly options: {
      db: DatabaseSync;
      pins?: LiteAgentPins;
      revision: () => number;
      changed: () => void;
      transaction: <T>(run: () => T) => T;
    },
  ) {}

  refresh(): void {
    if (!this.options.pins) return;
    const ids = pins(this.options.pins.read());
    const signature = JSON.stringify(ids);
    if (
      signature === this.signature &&
      this.revision === this.options.revision()
    )
      return;
    this.options.transaction(() => {
      const { db } = this.options;
      const find = db.prepare(
        "SELECT resource_key FROM collaboration_resources WHERE kind='agent' AND deleted=0 AND json_extract(metadata,'$.agent_id')=? LIMIT 101",
      );
      const desired = new Set<string>();
      for (const id of ids) {
        const rows = find.all(id);
        if (rows.length > 100)
          throw Error("Agent identity has too many indexed conversations");
        for (const row of rows) desired.add(row.resource_key as string);
      }
      const current = db
        .prepare(
          "SELECT p.resource_key FROM collaboration_personal p JOIN collaboration_resources r USING(resource_key) WHERE p.kind='agent' AND p.collected=1 AND json_extract(r.metadata,'$.agent_id') IS NOT NULL",
        )
        .all()
        .map((row) => row.resource_key as string);
      if (
        current.length !== desired.size ||
        current.some((key) => !desired.has(key))
      ) {
        const clear = db.prepare(
          "UPDATE collaboration_personal SET collected=0 WHERE resource_key=?",
        );
        for (const key of current) clear.run(key);
        const set = db.prepare(
          "INSERT INTO collaboration_personal(resource_key,kind,collected) VALUES(?,'agent',1) ON CONFLICT(resource_key) DO UPDATE SET collected=1",
        );
        for (const key of desired) set.run(key);
        this.options.changed();
      }
      this.signature = signature;
      this.revision = this.options.revision();
    });
  }

  set(agent_id: string | undefined, collected: boolean): void {
    if (!this.options.pins)
      throw Error("Lite Agents personal-state adapter is unavailable");
    if (
      !agent_id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        agent_id,
      )
    )
      throw Error(
        "Agent has no verified identity; register it through Agents first",
      );
    this.options.pins.set(agent_id, collected);
    this.refresh();
  }
}
