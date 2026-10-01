/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CollaborationCensusStore } from "./census-store";
import { CollaborationJournal } from "./journal";
import { censusReporter } from "./census-report";
const project_id = randomUUID();
let store: CollaborationCensusStore,
  journal: CollaborationJournal,
  directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "census-report-"));
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  const run = store.begin({
    project_id,
    run_id: randomUUID(),
    root: "/home/user",
    authority: "host",
    volume_id: "volume",
    policy_version: "v1",
  });
  store.recordDiscovery(run, []);
});
afterEach(() => {
  store.close();
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
test("empty completed census reports once without periodic heartbeats", async () => {
  let now = 0;
  const send = jest.fn(async () => {}),
    current = jest.fn(async () => ({ run_id: null }));
  const report = censusReporter({ store, send, current, now: () => now });
  await report(journal);
  expect(send.mock.calls[0][0]).toMatchObject({
    project_id,
    expected_run_id: null,
    report: { coverage: "complete", sequence: 1, source_pending: 0 },
  });
  expect(JSON.stringify(send.mock.calls)).not.toContain("/home");
  await report(journal);
  expect(send).toHaveBeenCalledTimes(1);
  now = 30_000;
  await report(journal);
  expect(send).toHaveBeenCalledTimes(1);
});
test("lost ACK survives restart with exact original report despite newer work", async () => {
  const send = jest.fn(async (_write) => {
    throw Error("lost ACK");
  });
  const current = jest.fn(async () => ({ run_id: null }));
  await expect(
    censusReporter({ store, send, current, now: () => 0 })(journal),
  ).rejects.toThrow("lost ACK");
  const original = send.mock.calls[0][0];
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/new.chat",
  });
  send.mockImplementation(async () => {});
  await censusReporter({ store, send, current, now: () => 30_000 })(journal);
  expect(send.mock.calls[1][0]).toEqual(original);
  await censusReporter({ store, send, current, now: () => 60_000 })(journal);
  expect(send.mock.calls[2][0]).toMatchObject({
    report: { coverage: "indexing", source_pending: 1, sequence: 2 },
  });
});

test("change-only reports remain quiet across restart until durable progress changes", async () => {
  let now = 0;
  const send = jest.fn(async (_write) => {});
  const current = jest.fn(async () => ({ run_id: null }));
  const options = {
    send,
    current,
    now: () => now,
  };
  await censusReporter({ ...options, store })(journal);
  const checkpoint = store.reportCheckpoint(project_id);
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  const persist = jest.spyOn(store, "setReportCheckpoint");
  const report = censusReporter({ ...options, store });
  for (let day = 1; day <= 7; day++) {
    now = day * 86400000;
    await report(journal);
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(current).toHaveBeenCalledTimes(1);
  expect(persist).not.toHaveBeenCalled();
  expect(store.reportCheckpoint(project_id)).toBe(checkpoint);
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/later.chat",
  });
  await report(journal);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].report).toMatchObject({
    sequence: 2,
    source_pending: 1,
    coverage: "indexing",
  });
});

test("change-only mode retries an uncertain report exactly before publishing newer state", async () => {
  let now = 0;
  const send = jest.fn(async (_write) => {});
  send.mockRejectedValueOnce(Error("lost ACK"));
  const options = {
    send,
    current: async () => ({ run_id: null }),
    now: () => now,
  };
  await expect(censusReporter({ ...options, store })(journal)).rejects.toThrow(
    "lost ACK",
  );
  const original = send.mock.calls[0][0];
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/new.chat",
  });
  const report = censusReporter({ ...options, store });
  await report(journal);
  expect(send).toHaveBeenCalledTimes(1);
  now = 30_000;
  await report(journal);
  expect(send.mock.calls[1][0]).toEqual(original);
  now = 60_000;
  await report(journal);
  expect(send.mock.calls[2][0].report).toMatchObject({
    sequence: 2,
    source_pending: 1,
  });
  now = 90_000;
  await report(journal);
  expect(send).toHaveBeenCalledTimes(3);
});

test("settled change-only reporting does not inspect quiet projects", async () => {
  let now = 0;
  const report = censusReporter({
    store,
    send: async () => {},
    current: async () => ({ run_id: null }),
    now: () => now,
  });
  await report(journal);
  now = 30000;
  await report(journal);
  const status = jest.spyOn(store, "status");
  const progress = jest.spyOn(journal, "censusProgress");
  const inventory = jest.spyOn(store, "nextProject");
  for (let i = 0; i < 20; i++) {
    now += 86400000;
    await report(journal);
  }
  expect(status).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/wakeup.chat",
  });
  status.mockClear();
  await report(journal);
  expect(status).toHaveBeenCalledTimes(1);
});

test("lost cross-store handoff ACK retains the journal signal and retries safely", async () => {
  let now = 0;
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/known.chat",
  });
  const queue = store.reportWorkQueue();
  const enqueue = queue.enqueue.bind(queue);
  jest.spyOn(queue, "enqueue").mockImplementationOnce((id) => {
    enqueue(id);
    throw Error("handoff ACK lost");
  });
  const send = jest.fn(async () => {});
  const report = censusReporter({
    store,
    send,
    current: async () => ({ run_id: null }),
    now: () => now,
  });
  await expect(report(journal)).rejects.toThrow("handoff ACK lost");
  expect(journal.progressSignalQueue().page()).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  now = 30000;
  await report(journal);
  expect(journal.progressSignalQueue().page()).toEqual([]);
  expect(queue.due(now)).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
});

test("disable during report preparation retains unsent durable work", async () => {
  let now = 0,
    enabled = true;
  const send = jest.fn(async () => {});
  const report = censusReporter({
    store,
    send,
    current: async () => {
      enabled = false;
      return { run_id: null };
    },
    enabled: () => enabled,
    now: () => now,
  });
  await report(journal);
  expect(send).not.toHaveBeenCalled();
  expect(store.reportWorkQueue().due(30000)).toHaveLength(1);
  enabled = true;
  now = 30000;
  await report(journal);
  expect(send).toHaveBeenCalledTimes(1);
});
test("registration and extraction failures cannot be called a complete census", async () => {
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/missing.chat",
  });
  journal.defer(journal.registrations()[0], 0);
  const send = jest.fn(async (_write) => {});
  await censusReporter({
    store,
    send,
    current: async () => ({ run_id: null }),
  })(journal);
  expect(send.mock.calls[0][0]).toMatchObject({
    report: { coverage: "partial", source_pending: 1, source_errors: 1 },
  });
});
test("empty new owner can reanchor telemetry but another live run cannot be stolen", async () => {
  const old = randomUUID();
  const current = jest
    .fn()
    .mockResolvedValueOnce({ run_id: old })
    .mockResolvedValue({ run_id: null });
  const send = jest
    .fn()
    .mockRejectedValueOnce(Error("owner moved"))
    .mockResolvedValue({});
  const report = censusReporter({ store, current, send, now: () => 0 });
  await expect(report(journal)).rejects.toThrow("owner moved");
  await censusReporter({ store, current, send, now: () => 30_000 })(journal);
  expect(send.mock.calls[1][0].expected_run_id).toBeNull();
});

test("compacted runs preserve exact lost-ACK retry and still report later source failures", async () => {
  let now = 0;
  const send = jest.fn(async (_write) => {
    throw Error("lost ACK");
  });
  const options = {
    store,
    send,
    current: async () => ({ run_id: null }),
    now: () => now,
  };
  await expect(censusReporter(options)(journal)).rejects.toThrow("lost ACK");
  const original = send.mock.calls[0][0];
  expect(store.compactCompleted()).toBe(1);
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal.acceptCensusCandidate({
    project_id,
    run_id: store.status(project_id)!.run.run_id,
    chat_path: "/home/user/failure.chat",
  });
  journal.defer(journal.registrations()[0], now);
  send.mockImplementation(async () => {});
  now = 30_000;
  await censusReporter({ ...options, store })(journal);
  expect(send.mock.calls[1][0]).toEqual(original);
  now = 60_000;
  await censusReporter({ ...options, store })(journal);
  expect(send.mock.calls[2][0].report).toMatchObject({
    coverage: "partial",
    traversal_complete: true,
    source_errors: 1,
    source_pending: 1,
  });
});

test("failed owner backs off without blocking other queued reports across restart", async () => {
  const ids = [
    project_id,
    ...Array.from({ length: 20 }, () => randomUUID()),
  ].sort();
  for (const id of ids.filter((id) => id !== project_id)) {
    const run = store.begin({
      project_id: id,
      run_id: randomUUID(),
      root: "/home/user",
      authority: "host",
      volume_id: "volume",
      policy_version: "v1",
    });
    store.recordDiscovery(run, []);
  }
  const delivered: string[] = [];
  const current = async (id: string) => {
    if (id === ids[0]) throw Error("owner unavailable");
    return { run_id: null };
  };
  const report = censusReporter({
    store,
    current,
    now: () => 0,
    send: async (write) => {
      delivered.push(write.project_id);
    },
  });
  await expect(report(journal)).rejects.toThrow("owner unavailable");
  expect(delivered).toEqual(ids.slice(1, 16));
  expect(store.reportWorkQueue().due(0)).toHaveLength(5);
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  await censusReporter({
    store,
    current,
    now: () => 0,
    send: async (write) => {
      delivered.push(write.project_id);
    },
  })(journal);
  expect(delivered).toEqual(ids.slice(1));
});

test("report batch stops at its cooperative budget or feature disable", async () => {
  for (let i = 0; i < 5; i++) {
    const run = store.begin({
      project_id: randomUUID(),
      run_id: randomUUID(),
      root: "/home/user",
      authority: "host",
      volume_id: "volume",
      policy_version: "v1",
    });
    store.recordDiscovery(run, []);
  }
  let now = 0;
  const send = jest.fn(async () => {
    now += 600;
  });
  await censusReporter({
    store,
    current: async () => ({ run_id: null }),
    send,
    now: () => now,
  })(journal);
  expect(send).toHaveBeenCalledTimes(1);
  await censusReporter({
    store,
    current: async () => ({ run_id: null }),
    send,
    enabled: () => false,
  })(journal);
  expect(send).toHaveBeenCalledTimes(1);
});
