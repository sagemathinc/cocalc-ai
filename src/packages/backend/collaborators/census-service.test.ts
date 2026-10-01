/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CollaborationCensusStore } from "./census-store";
import { createCensusProducer } from "./census-producer";
import { censusReporter } from "./census-report";
import { CollaboratorsService } from "./service";

test("census handoff and ingest ACK loss recover together without re-extraction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-service-"));
  const project_id = randomUUID();
  let now = 0;
  let service: CollaboratorsService | undefined;
  let store: CollaborationCensusStore | undefined;
  const discover = jest.fn();
  const read = jest.fn(async () => ({ resources: [], activity_ids: {} }));
  const register = jest.fn(async () => ({ epoch: "epoch" }));
  const send = jest.fn(async (_snapshot) => ({ revision: 1, replayed: true }));
  send.mockRejectedValueOnce(Error("ingest ACK lost"));
  const report = jest.fn(async (_write) => {});
  const onError = jest.fn();
  function open() {
    store = new CollaborationCensusStore(join(directory, "census.sqlite"));
    const census = createCensusProducer({
      store,
      enabled: () => true,
      validate: async () => {},
      discover,
      onError,
      now: () => now,
      publish: censusReporter({
        store,
        current: async () => ({ run_id: null }),
        send: report,
        now: () => now,
      }),
    });
    service = new CollaboratorsService({
      filename: join(directory, "journal.sqlite"),
      census,
      discover: async () => [],
      writerState: async () => null,
      register,
      read,
      send,
      onError,
      now: () => now,
    });
  }
  try {
    open();
    const run = store!.begin({
      project_id,
      run_id: randomUUID(),
      root: "/home/user",
      policy_version: "v1",
      authority: "host",
      volume_id: "volume",
    });
    // A completed traversal hands its retained candidate to the real service.
    store!.recordDiscovery(run, [run.root + "/unknown.chat"]);
    jest.spyOn(store!, "acknowledge").mockImplementationOnce(() => {
      throw Error("handoff ACK lost");
    });
    await service!.runOnce();
    expect(store!.status(project_id)?.pending_candidates).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].report.coverage).not.toBe("complete");
    const original = send.mock.calls[0][0];
    await service!.close();
    service = undefined;
    now = 30_000;
    open();
    await service!.runOnce();
    expect(store!.status(project_id)?.pending_candidates).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(register).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(service!.journal.scans()).toEqual([]);
    expect(service!.journal.deliveries(16, now)).toEqual([]);
    expect(report.mock.calls.at(-1)![0].report).toMatchObject({
      coverage: "complete",
      source_pending: 0,
      pending_candidates: 0,
    });
    now = 60_000;
    await service!.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
    expect(onError.mock.calls.map((args) => String(args.at(-1)))).toEqual([
      "Error: handoff ACK lost",
      "Error: ingest ACK lost",
    ]);
  } finally {
    await service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
