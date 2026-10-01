/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import fd from "@cocalc/backend/sandbox/fd";
import { createHostedCollaborationCensus } from "./collaborators-census";
import { getProject } from "./sqlite/projects";
import { resetProjectVolumeLifecycleForTesting } from "./project-volume-lifecycle";
import type { CollaborationDiscoveryWrite } from "@cocalc/util/collaboration-census";

jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(),
}));
jest.mock("./sqlite/hosts", () => ({ getLocalHostId: () => "host" }));
jest.mock("./sqlite/project-volumes", () => ({
  getRecordedProjectVolumeIdentity: (id: string) => `volume:${id}`,
}));

const linux = process.platform === "linux" ? test : test.skip;

linux(
  "1000 explicitly selected stopped projects discover nested chats and report across restart",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "host-census-scale-"));
    const ids = Array.from({ length: 1000 }, () => randomUUID()).sort();
    const failures = new Set([ids[7], ids[77]]);
    const owner = new Map<
      string,
      { write: CollaborationDiscoveryWrite; at: number }
    >();
    const retryPayloads = new Map<string, string>();
    let now = 0;
    let opened = 0;
    let maximumBytes = 0;
    let journal = new CollaborationJournal(join(directory, "journal.sqlite"));
    let census: ReturnType<typeof createHostedCollaborationCensus> | undefined;
    const errors: unknown[] = [];
    resetProjectVolumeLifecycleForTesting();
    (getProject as jest.Mock).mockReturnValue({ state: "stopped" });
    const create = () =>
      createHostedCollaborationCensus({
        filename: join(directory, "census.sqlite"),
        now: () => now,
        enabled: async () => true,
        authorize: async () => {},
        current: async (id) => ({
          run_id: owner.get(id)?.write.report.run_id ?? null,
        }),
        report: async (write) => {
          const pending = retryPayloads.get(write.project_id);
          if (pending) {
            expect(JSON.stringify(write)).toBe(pending);
            retryPayloads.delete(write.project_id);
          }
          owner.set(write.project_id, { write, at: now });
          if (failures.delete(write.project_id)) {
            retryPayloads.set(write.project_id, JSON.stringify(write));
            throw Error("simulated lost owner ACK");
          }
        },
        onError: (error) => errors.push(error),
        getFilesystem: async (id) => {
          opened++;
          const root = join(directory, id);
          return {
            fd: (path: string, options: any) =>
              fd(join(root, posix.relative("/home/user", path)), options),
            close: () => {},
          } as any;
        },
      });
    try {
      for (const id of ids) {
        mkdirSync(join(directory, id, "historical"), { recursive: true });
        writeFileSync(
          join(directory, id, "historical", "unregistered.chat"),
          JSON.stringify({ event: "chat-thread", thread_id: randomUUID() }),
        );
      }
      census = create();
      expect(census.store.usage().projects).toBe(0);
      for (const id of ids) expect(census.store.status(id)).toBeUndefined();
      expect(opened).toBe(0);
      expect(journal.sources()).toEqual([]);
      for (const project_id of ids)
        await census.requestReconciliation({
          project_id,
          run_id: randomUUID(),
        });
      let restarted = false;
      for (let step = 0; step < 4500; step++) {
        await census.producer.step(journal);
        // Interleave bounded reporting with the admitted traversal.
        if (step % 16 === 0)
          await census.producer.report!(journal).catch((error) =>
            errors.push(error),
          );
        const usage = census.store.usage();
        maximumBytes = Math.max(maximumBytes, usage.bytes);
        expect(usage.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(usage.projects).toBeLessThanOrEqual(4096);
        if (step === 10) {
          const before = census.store.status(ids[500]);
          await census.producer.close();
          journal.close();
          journal = new CollaborationJournal(join(directory, "journal.sqlite"));
          census = create();
          expect(census.store.status(ids[500])).toEqual(before);
          restarted = true;
        }
        now += 2000;
        if (usage.projects === 1000 && usage.frontiers === 0) break;
      }
      expect(restarted).toBe(true);
      expect(census.store.usage()).toMatchObject({
        projects: 1000,
        frontiers: 0,
      });
      // The journal API pages; do not mistake its first 100 sources for the census.
      for (const id of ids) {
        const status = census.store.status(id)!;
        expect(status).toMatchObject({
          candidates: 1,
          pending_candidates: 0,
          traversal_complete: true,
        });
        expect(
          journal.acceptCensusCandidate({
            project_id: id,
            run_id: status.run.run_id,
            chat_path: "/home/user/historical/unregistered.chat",
          }),
        ).toBe(false);
      }
      expect(maximumBytes).toBeLessThan(64 * 1024 * 1024);
      // Reports must remain indexing while source ingestion is still pending,
      // despite completed/compacted traversal. A failed source remains partial.
      journal.defer(journal.registrations()[0], now);
      for (let i = 0; i < 130; i++) {
        await census.producer.report!(journal).catch((error) =>
          errors.push(error),
        );
        now += 2000;
      }
      expect(owner.size).toBe(1000);
      for (const { write } of owner.values())
        expect(write.report.coverage).not.toBe("complete");
      expect(
        [...owner.values()].some(
          ({ write }) =>
            write.report.coverage === "partial" &&
            write.report.source_errors > 0,
        ),
      ).toBe(true);
      expect(retryPayloads.size).toBe(0);
      expect(
        errors.every((error) =>
          String(error).includes("simulated lost owner ACK"),
        ),
      ).toBe(true);
      const before = opened;
      for (const id of ids) census.store.status(id);
      expect(opened).toBe(before);
    } finally {
      await census?.producer.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

linux(
  "manual mixed-project traversal measures bounded work and cancellation",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "manual-scan-cost-"));
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const journal = new CollaborationJournal(join(directory, "journal.sqlite"));
    const errors: unknown[] = [];
    let opened = 0;
    resetProjectVolumeLifecycleForTesting();
    (getProject as jest.Mock).mockReturnValue({ state: "stopped" });
    const options = {
      filename: join(directory, "census.sqlite"),
      enabled: async () => true,
      authorize: async () => {},
      current: async () => ({ run_id: null }),
      report: async () => {},
      onError: (error: unknown) => errors.push(error),
      getFilesystem: async (id: string) => {
        opened++;
        const root = join(directory, id);
        return {
          fd: (path: string, options: any) =>
            fd(join(root, posix.relative("/home/user", path)), options),
          close: () => {},
        } as any;
      },
    };
    let census = createHostedCollaborationCensus(options);
    try {
      for (const id of ids) {
        mkdirSync(join(directory, id));
        for (let i = 0; i < 1000; i++)
          writeFileSync(
            join(directory, id, `source-${i}.${i < 50 ? "chat" : "txt"}`),
            "",
          );
      }
      for (let i = 0; i < 10; i++) await census.producer.step(journal);
      expect(opened).toBe(0);
      const runs = ids.map((project_id) => ({
        project_id,
        run_id: randomUUID(),
      }));
      const cpu = process.cpuUsage(),
        start = performance.now();
      for (const run of runs) await census.requestReconciliation(run);
      await census.producer.step(journal);
      const cancelStart = performance.now();
      await census.cancelReconciliation(runs[0]);
      const cancelMs = performance.now() - cancelStart;
      const before = census.store.status(ids[0])!.entries;
      await census.producer.close();
      census = createHostedCollaborationCensus(options);
      let passes = 0;
      for (; passes < 250; passes++) {
        await census.producer.step(journal);
        if (
          ids.slice(1).every((id) => {
            const s = census.store.status(id)!;
            return s.traversal_complete && !s.pending_candidates;
          })
        )
          break;
      }
      expect(passes).toBeLessThan(250);
      expect(errors).toEqual([]);
      expect(census.store.status(ids[0])!.entries).toBe(before);
      expect(await census.reconciliationStatus(runs[0])).toEqual({
        state: "cancelled",
        run_id: runs[0].run_id,
      });
      for (const id of ids.slice(1))
        expect(census.store.status(id)).toMatchObject({
          entries: 0,
          candidates: 50,
          traversal_complete: true,
          pending_candidates: 0,
        });
      const usage = process.cpuUsage(cpu);
      process.stdout.write(
        JSON.stringify({
          manual_scan_fixture: {
            selected_projects: 4,
            completed_projects: 3,
            cancelled_projects: 1,
            fixture_entries: 3000,
            sources: 150,
            passes,
            elapsed_ms: Math.round(performance.now() - start),
            cancel_ms: Math.round(cancelMs * 100) / 100,
            cpu_ms: Math.round((usage.user + usage.system) / 1000),
            census_bytes: census.store.usage().bytes,
          },
        }) + "\n",
      );
    } finally {
      await census.producer.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60000,
);
