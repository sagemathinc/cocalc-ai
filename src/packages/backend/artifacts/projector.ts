/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type {
  ArtifactCatalogItem,
  ArtifactCatalogSnapshot,
} from "@cocalc/util/artifact-catalog";
import { ArtifactCatalogJournal, type CatalogScan } from "./journal";

/**
 * One bounded service-owned pass, never invoked by opening a browser panel.
 * Readers must read a complete, bounded source through the project sandbox.
 * ENOENT may be represented by []; permissions, parse and capacity errors MUST
 * reject instead. Send must resolve only after the owning bay commits ingestion.
 */
export class ArtifactCatalogProjector {
  private running = false;
  private stopped = false;

  constructor(
    private readonly options: {
      journal: ArtifactCatalogJournal;
      read: (source: CatalogScan) => Promise<ArtifactCatalogItem[]>;
      send: (snapshot: ArtifactCatalogSnapshot) => Promise<void>;
      onError: (
        source: CatalogScan | ArtifactCatalogSnapshot,
        error: unknown,
      ) => void;
      now?: () => number;
    },
  ) {}

  stop() {
    this.stopped = true;
  }

  async runOnce(limit = 16): Promise<{ scanned: number; delivered: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid artifact projection limit");
    const result = { scanned: 0, delivered: 0 };
    if (this.running || this.stopped) return result;
    this.running = true;
    const { journal, read, send, onError } = this.options;
    const now = this.options.now ?? Date.now;
    const failed = (
      source: CatalogScan | ArtifactCatalogSnapshot,
      error: unknown,
    ) => {
      journal.defer(source, now());
      onError(source, error);
    };
    try {
      for (const source of journal.scans(limit, now())) {
        if (this.stopped) break;
        try {
          const items = await read(source);
          if (this.stopped) break;
          if (journal.prepare(source, items)) result.scanned++;
        } catch (error) {
          failed(source, error);
        }
      }
      for (const snapshot of journal.deliveries(limit, now())) {
        if (this.stopped) break;
        try {
          // Keep the slot while the actual request is in flight. A timeout
          // wrapper that abandons it could multiply concurrent deliveries.
          await send(snapshot);
          journal.acknowledge(snapshot);
          result.delivered++;
        } catch (error) {
          failed(snapshot, error);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
