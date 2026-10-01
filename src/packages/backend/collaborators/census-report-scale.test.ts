/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CollaborationCensusStore } from "./census-store";
import { CollaborationJournal } from "./journal";
import { censusReporter } from "./census-report";

const scale =
  process.env.COCALC_PEOPLE_SCALE_ACCEPTANCE === "1" ? test : test.skip;
scale.each([0, 10000, 100000])(
  "report queue costs with %i dormant projects",
  async (population) => {
    const directory = mkdtempSync(join(tmpdir(), "report-scale-"));
    const capacity = { projects: 110000, bytes: 512 * 1024 * 1024 };
    const store = new CollaborationCensusStore(
      join(directory, "census.sqlite"),
      capacity,
    );
    const journal = new CollaborationJournal(
      join(directory, "journal.sqlite"),
      { sources: 110000, bytes: capacity.bytes },
    );
    const censusDb = new DatabaseSync(join(directory, "census.sqlite"));
    const journalDb = new DatabaseSync(join(directory, "journal.sqlite"));
    const projectId = (i: number) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    try {
      // Bulk fixture seeding is outside the measured path. It is not admission throughput.
      const run = store.begin({
        project_id: projectId(0),
        run_id: randomUUID(),
        root: "/home/user",
        authority: "host",
        volume_id: "volume",
        policy_version: "v1",
      });
      store.recordDiscovery(run, []);
      store.compactCompleted();
      const template = censusDb.prepare("SELECT * FROM census_runs").get()!;
      censusDb.exec("DELETE FROM census_runs; BEGIN");
      journalDb.exec("BEGIN");
      const censusInsert = censusDb.prepare(
        "INSERT INTO census_runs(project_id,run_id,request,compact_status,bytes,reserved_bytes) VALUES(?,?,?,?,?,?)",
      );
      const sourceInsert = journalDb.prepare(
        "INSERT INTO sources(project_id,chat_path,registration_id,epoch,dirty) VALUES(?,'/home/user/a.chat','registration','epoch',0)",
      );
      for (let i = 0; i < population; i++) {
        const project_id = projectId(i);
        censusInsert.run(
          project_id,
          template.run_id,
          JSON.stringify({ ...run, project_id }),
          template.compact_status,
          template.bytes,
          template.reserved_bytes,
        );
        sourceInsert.run(project_id);
      }
      censusDb.exec("COMMIT");
      journalDb.exec("COMMIT");
      const toggle = journalDb.prepare(
        "UPDATE sources SET dirty=1-dirty WHERE project_id=?",
      );
      const mutationCost = () => {
        const start = performance.now();
        journalDb.exec("BEGIN");
        for (let i = 0; i < 1000; i++) toggle.run(projectId(0));
        journalDb.exec("COMMIT");
        return performance.now() - start;
      };
      const baseline_mutation_ms = population ? mutationCost() : null;
      const installStart = performance.now();
      const queue = store.reportWorkQueue();
      const signals = journal.progressSignalQueue();
      const initial_install_ms = performance.now() - installStart;
      expect(signals.page("", 100)).toHaveLength(Math.min(population, 16));
      expect(queue.due(0, 100)).toHaveLength(Math.min(population, 16));
      const adoptionStart = performance.now();
      let adoption_pages = 0;
      for (;;) {
        const reportPage = queue.adopt(100);
        const signalPage = signals.adopt(100);
        adoption_pages++;
        expect(reportPage.examined).toBeLessThanOrEqual(100);
        expect(signalPage.examined).toBeLessThanOrEqual(100);
        if (reportPage.complete && signalPage.complete) break;
      }
      const adoption_ms = performance.now() - adoptionStart;
      expect(
        censusDb.prepare("SELECT count(*) n FROM census_report_queue").get()!.n,
      ).toBe(population);
      expect(
        journalDb
          .prepare("SELECT count(*) n FROM collaboration_progress_signals")
          .get()!.n,
      ).toBe(population);
      // Model an already-drained population, not the cost of initial delivery.
      censusDb.exec("DELETE FROM census_report_queue");
      journalDb.exec("DELETE FROM collaboration_progress_signals");
      const triggered_mutation_ms = population ? mutationCost() : null;
      if (population) expect(signals.page()).toHaveLength(1);
      journalDb.exec("DELETE FROM collaboration_progress_signals");
      const status = jest.spyOn(store, "status");
      const progress = jest.spyOn(journal, "censusProgress");
      const cursor = jest.spyOn(store, "setCheckpoint");
      const send = jest.fn(async () => {});
      const current = jest.fn(async () => ({ run_id: null }));
      const report = censusReporter({
        store,
        send,
        current,
        now: () => 30000,
      });
      const samples: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        await report(journal);
        samples.push(performance.now() - start);
      }
      expect(status).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
      expect(cursor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(current).not.toHaveBeenCalled();
      if (population) {
        journal.touch({
          project_id: projectId(population - 1),
          chat_path: "/home/user/a.chat",
        });
        await report(journal);
        expect(status).toHaveBeenCalledTimes(1);
        expect(progress).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(signals.page()).toEqual([]);
        expect(queue.due(30000)).toEqual([]);
      }
      samples.sort((a, b) => a - b);
      process.stdout.write(
        JSON.stringify({
          scenario: "census-report-dormant",
          population,
          initial_install_ms,
          adoption_pages,
          adoption_ms,
          baseline_mutation_ms,
          triggered_mutation_ms,
          mutation_count: population ? 1000 : 0,
          idle_passes: samples.length,
          idle_p50_ms: samples[49],
          idle_p95_ms: samples[94],
        }) + "\n",
      );
    } finally {
      censusDb.close();
      journalDb.close();
      store.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120000,
);
