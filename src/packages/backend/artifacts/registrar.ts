/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type { ArtifactCatalogSource } from "@cocalc/util/artifact-catalog";
import { ArtifactCatalogJournal, type CatalogRegistration } from "./journal";

/**
 * Portable registration pass: the transport is owning-bay RPC on project hosts
 * and local storage in Lite. No network request runs in a file-write path.
 * The service must fence previous processes before starting this worker.
 */
export class ArtifactCatalogRegistrar {
  private running = false;
  private stopped = false;

  constructor(
    private readonly options: {
      journal: ArtifactCatalogJournal;
      writerState: (
        source: ArtifactCatalogSource,
      ) => Promise<{ epoch: string; registration_id: string } | null>;
      register: (
        request: CatalogRegistration & { expected_epoch: string | null },
      ) => Promise<{ epoch: string }>;
      onError: (source: CatalogRegistration, error: unknown) => void;
      now?: () => number;
    },
  ) {}

  stop() {
    this.stopped = true;
  }

  async runOnce(limit = 16): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid artifact registration limit");
    if (this.stopped || this.running) return 0;
    this.running = true;
    let registered = 0;
    const { journal, writerState, register, onError } = this.options;
    const now = this.options.now ?? Date.now;
    try {
      for (const source of journal.pendingRegistrations(limit, now())) {
        if (this.stopped) break;
        try {
          let base = journal.registrationBase(source);
          if (!base) {
            const current = await writerState(source);
            if (this.stopped) break;
            if (current?.registration_id === source.registration_id) {
              journal.register(source, current.epoch);
              registered++;
              continue;
            }
            base = journal.prepareRegistration(source, current?.epoch ?? null);
          }
          if (this.stopped) break;
          const { epoch } = await register({ ...source, ...base });
          if (this.stopped) break;
          journal.register(source, epoch);
          registered++;
        } catch (error) {
          journal.deferRegistration(source, now());
          onError(source, error);
        }
      }
      return registered;
    } finally {
      this.running = false;
    }
  }
}
