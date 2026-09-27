/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import { akv } from "@cocalc/conat/sync/akv";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import {
  COCALC_TOMBSTONE_HEADER,
  storagePath,
} from "@cocalc/conat/sync/core-stream";

export const PROJECT_PIN_LIMIT = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectPins {
  read(): Promise<string[]>;
  set(project_id: string, pinned: boolean): Promise<void>;
  /** Metadata-only invalidation, including writes from the existing Favorites UI. */
  revision(): Promise<string>;
}

export function projectPinIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Error("Invalid project favorites");
  if (value.length > PROJECT_PIN_LIMIT)
    throw Error("Project favorites exceed the 10000-project directory limit");
  if (value.some((id) => typeof id !== "string" || !UUID.test(id)))
    throw Error("Invalid project favorites");
  return [...new Set(value.map((id) => id.toLowerCase()))];
}

/** Reads only the existing favorites key, never all account DKV state. */
export function accountProjectPins(
  client: Client,
  account_id: string,
): ProjectPins {
  const open = () => akv({ client, account_id, name: "bookmarks" });
  return {
    async revision() {
      const stream = persistStream({
        client,
        user: { account_id },
        storage: { path: storagePath({ account_id, name: "bookmarks" }) },
      });
      try {
        const { seq } = await stream.inventory(5000);
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
          throw Error("Invalid project favorites revision");
        return String(seq);
      } finally {
        stream.close();
      }
    },
    async read() {
      const store = open();
      try {
        return projectPinIds(await store.get("projects", { timeout: 5000 }));
      } finally {
        store.close();
      }
    },
    async set(project_id, pinned) {
      if (!UUID.test(project_id) || typeof pinned !== "boolean")
        throw Error("Invalid project pin");
      const id = project_id.toLowerCase();
      const store = open();
      try {
        // CAS preserves other projects when another browser edits the same array.
        for (let attempt = 0; attempt < 4; attempt++) {
          const message = await store.getMessage("projects", {
            timeout: 5000,
            includeDeleted: true,
          });
          const ids = projectPinIds(
            message?.headers?.[COCALC_TOMBSTONE_HEADER]
              ? undefined
              : message?.data,
          );
          if (ids.includes(id) === pinned) return;
          const next = pinned
            ? [id, ...ids]
            : ids.filter((value) => value !== id);
          projectPinIds(next);
          try {
            await store.set("projects", next, {
              previousSeq: Number(message?.headers?.seq ?? 0),
              timeout: 5000,
            });
            return;
          } catch (error) {
            if (error?.code !== "wrong-last-sequence") throw error;
          }
        }
        throw Error("Project favorites changed concurrently; retry pinning");
      } finally {
        store.close();
      }
    },
  };
}
