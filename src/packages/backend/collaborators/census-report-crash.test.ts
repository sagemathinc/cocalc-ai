/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CollaborationCensusStore } from "./census-store";
import { CollaborationJournal } from "./journal";
import { censusReporter } from "./census-report";

// The child uses built production modules and exits without closing either WAL.
const child = `
const { join } = require('node:path');
const { writeSync } = require('node:fs');
const [directory, compiled, phase, project_id] = process.argv.slice(1);
const { CollaborationCensusStore } = require(join(compiled, 'census-store.js'));
const { CollaborationJournal } = require(join(compiled, 'journal.js'));
const { censusReporter } = require(join(compiled, 'census-report.js'));
const store = new CollaborationCensusStore(join(directory, 'census.sqlite'));
const journal = new CollaborationJournal(join(directory, 'journal.sqlite'));
const signals = journal.progressSignalQueue();
if (phase === 'handoff') {
  journal.touch({ project_id, chat_path: '/home/user/crash.chat' });
  signals.acknowledge = () => process.kill(process.pid, 'SIGKILL');
}
censusReporter({
  store, reporting: 'changes', now: () => 0,
  current: async () => ({ run_id: null }),
  send: async (write) => {
    writeSync(1, JSON.stringify(write));
    process.kill(process.pid, 'SIGKILL');
  },
})(journal).catch((error) => {
  writeSync(2, String(error));
  process.exitCode = 1;
});
`;

test("cross-store report work survives SIGKILL at both acknowledgement boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-report-crash-"));
  const project_id = randomUUID();
  let store: CollaborationCensusStore | undefined;
  let journal: CollaborationJournal | undefined;
  const open = () => {
    store = new CollaborationCensusStore(join(directory, "census.sqlite"));
    journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  };
  const close = () => {
    store?.close();
    store = undefined;
    journal?.close();
    journal = undefined;
  };
  const crash = (phase: string) => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        child,
        directory,
        join(__dirname, "../dist/collaborators"),
        phase,
        project_id,
      ],
      {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      },
    );
    if (result.error || result.signal !== "SIGKILL")
      throw Error(
        `crash worker failed: ${result.error ?? result.status}\n${result.stderr}`,
      );
    return result.stdout;
  };
  try {
    open();
    const run = store!.begin({
      project_id,
      run_id: randomUUID(),
      root: "/home/user",
      authority: "host",
      volume_id: "volume",
      policy_version: "v1",
    });
    store!.record({ run, path: run.root, depth: 0 }, [], true);
    close();
    expect(crash("handoff")).toBe("");
    open();
    expect(journal!.progressSignalQueue().page()).toHaveLength(1);
    expect(store!.reportWorkQueue().due(0)).toHaveLength(1);
    expect(store!.reportCheckpoint(project_id)).toBeUndefined();
    close();
    const original = JSON.parse(crash("send"));
    open();
    expect(journal!.progressSignalQueue().page()).toEqual([]);
    expect(JSON.parse(store!.reportCheckpoint(project_id)!)).toMatchObject({
      acknowledged: false,
      write: original,
      retry_at: 30000,
    });
    let now = 1;
    const send = jest.fn(async (_write) => {});
    const current = jest.fn(async () => {
      throw Error("retry must use the retained CAS");
    });
    const report = censusReporter({
      store: store!,
      send,
      current,
      now: () => now,
      reporting: "changes",
    });
    await report(journal!);
    expect(send).not.toHaveBeenCalled();
    expect(store!.reportWorkQueue().due(now)).toEqual([]);
    now = 30000;
    await report(journal!);
    expect(send.mock.calls).toEqual([[original]]);
    expect(current).not.toHaveBeenCalled();
    now = 60000;
    await report(journal!);
    expect(store!.reportWorkQueue().due(now)).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 40000);
