/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationCensusStore } from "./census-store";
import { CollaborationJournal } from "./journal";
import { createCensusProducer } from "./census-producer";
const project_id = "11111111-1111-4111-8111-111111111111";
let directory: string,
  store: CollaborationCensusStore,
  journal: CollaborationJournal;
let producer: ReturnType<typeof createCensusProducer> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "census-producer-"));
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
});
afterEach(async () => {
  await producer?.close();
  producer = undefined;
  store.close();
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function candidate() {
  const run = store.begin({
    project_id,
    run_id: "run",
    root: "/home/user",
    policy_version: "v1",
    authority: "host",
    volume_id: "volume",
  });
  store.recordDiscovery(run, [run.root + "/unknown.chat"]);
  return store.candidates(0)[0];
}
function setup(overrides = {}) {
  const options = {
    store,
    enabled: jest.fn(() => true),
    openReader: jest.fn(),
    validate: jest.fn(async () => {}),
    onError: jest.fn(),
    now: () => 0,
    ...overrides,
  };
  producer = createCensusProducer(options);
  return options;
}
test("handoff adopts unknown source without reading it and survives a lost ACK", async () => {
  const source = candidate();
  const opts = setup();
  const ack = jest.spyOn(store, "acknowledge").mockImplementationOnce(() => {
    throw Error("ACK lost");
  });
  await producer!.step(journal);
  const first = journal.registrations()[0];
  expect(first).toMatchObject({ project_id, chat_path: source.chat_path });
  expect(opts.openReader).not.toHaveBeenCalled();
  ack.mockRestore();
  journal.acceptCensusCandidate(source);
  expect(journal.registrations()[0]).toEqual(first);
  expect(store.status(project_id)?.pending_candidates).toBe(1);
  expect(journal.acceptCensusCandidate(source)).toBe(false);
});
test("scope failure preserves pending candidate without registering it", async () => {
  candidate();
  const opts = setup({
    validate: jest.fn(async () => {
      throw Error("host reassigned");
    }),
  });
  await producer!.step(journal);
  expect(journal.registrations()).toEqual([]);
  expect(store.status(project_id)).toMatchObject({
    coverage: "partial",
    pending_candidates: 1,
  });
  expect(opts.onError).toHaveBeenCalled();
});
test("disabled producer neither opens, schedules nor accepts files", async () => {
  candidate();
  const opts = setup({ enabled: () => false });
  await producer!.step(journal);
  expect(opts.validate).not.toHaveBeenCalled();
  expect(journal.registrations()).toEqual([]);
});
test("journal receipts persist atomically with dirty source intent", () => {
  const source = candidate();
  expect(journal.acceptCensusCandidate(source)).toBe(true);
  const first = journal.registrations()[0];
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.acceptCensusCandidate(source)).toBe(false);
  expect(journal.registrations()[0]).toEqual(first);
  expect(journal.acceptCensusCandidate({ ...source, run_id: "new-run" })).toBe(
    true,
  );
});
