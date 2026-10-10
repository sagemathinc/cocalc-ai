/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  deleteOldForwardedCallRecords,
  forwardedCallHash,
  runForwardedCallOnce,
  type ForwardedOutcome,
} from "./forwarded-calls";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
let n = 0;
const callId = () => `22222222-2222-4222-8222-${`${++n}`.padStart(12, "0")}`;

function once(
  call_id: string,
  run: () => Promise<ForwardedOutcome>,
  overrides: { name?: string; wait_ms?: number; args?: any[] } = {},
) {
  const name = overrides.name ?? "projects.setProjectMetadata";
  const call = {
    call_id,
    name,
    args: overrides.args ?? [{ project_id: "p", patch: { title: "t" } }],
    account_id: ACCOUNT,
    source_bay_id: "bay-0",
  };
  return runForwardedCallOnce({
    call_id,
    name,
    account_id: ACCOUNT,
    source_bay_id: "bay-0",
    call_hash: forwardedCallHash(call),
    wait_ms: overrides.wait_ms ?? 2_000,
    run,
  });
}

describe("runForwardedCallOnce", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("runs a call once and returns its outcome to a repeat", async () => {
    const call_id = callId();
    const run = jest.fn(async () => ({
      ok: true as const,
      result: { at: new Date("2026-10-10T00:00:00Z"), n: 1 },
    }));
    const first = await once(call_id, run);
    const repeat = await once(call_id, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(repeat).toEqual(first);
    // Dates survive the record, as they do on the wire.
    expect((repeat as any).result.at).toBeInstanceOf(Date);
  });

  it("replays an error outcome with its attributes", async () => {
    const call_id = callId();
    const run = jest.fn(async () => ({
      ok: false as const,
      error: "only collaborators may do this",
      attrs: { code: 403 },
    }));
    await once(call_id, run);
    await expect(once(call_id, run)).resolves.toEqual({
      ok: false,
      error: "only collaborators may do this",
      attrs: { code: 403 },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a repeat wait for the first attempt to finish", async () => {
    const call_id = callId();
    let finish!: () => void;
    const slow = jest.fn(
      () =>
        new Promise<ForwardedOutcome>((resolve) => {
          finish = () => resolve({ ok: true, result: "done" });
        }),
    );
    const first = once(call_id, slow);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const repeat = once(call_id, slow);
    setTimeout(() => finish(), 300);
    await expect(repeat).resolves.toEqual({ ok: true, result: "done" });
    await expect(first).resolves.toEqual({ ok: true, result: "done" });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("says the outcome is unknown while the first attempt is still running", async () => {
    const call_id = callId();
    let finish!: () => void;
    const first = once(
      call_id,
      () =>
        new Promise<ForwardedOutcome>((resolve) => {
          finish = () => resolve({ ok: true, result: null });
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      once(call_id, async () => ({ ok: true, result: "again" }), {
        wait_ms: 300,
      }),
    ).resolves.toMatchObject({
      ok: false,
      attrs: { code: "OUTCOME_UNKNOWN" },
    });
    finish();
    await first;
  });

  it("refuses a call id reused for a different call", async () => {
    const call_id = callId();
    await once(call_id, async () => ({ ok: true, result: 1 }));
    // Another method, or the same method with other arguments.
    await expect(
      once(call_id, async () => ({ ok: true, result: 2 }), {
        name: "projects.removeCollaborator",
      }),
    ).resolves.toMatchObject({ ok: false, attrs: { code: 400 } });
    await expect(
      once(call_id, async () => ({ ok: true, result: 2 }), {
        args: [{ project_id: "other", patch: { title: "t" } }],
      }),
    ).resolves.toMatchObject({ ok: false, attrs: { code: 400 } });
  });

  it("keeps the record of a call that never finished, however old", async () => {
    const call_id = callId();
    let finish!: () => void;
    const first = once(
      call_id,
      () =>
        new Promise<ForwardedOutcome>((resolve) => {
          finish = () => resolve({ ok: true, result: "late" });
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A stalled call, claimed two hours ago.
    await getPool().query(
      "UPDATE hub_api_forwarded_calls SET created = now() - INTERVAL '2 hours' WHERE call_id = $1",
      [call_id],
    );
    await deleteOldForwardedCallRecords();
    const again = jest.fn(async () => ({ ok: true as const, result: "twice" }));
    await expect(once(call_id, again, { wait_ms: 200 })).resolves.toMatchObject(
      { ok: false, attrs: { code: "OUTCOME_UNKNOWN" } },
    );
    expect(again).not.toHaveBeenCalled();
    finish();
    await first;
  });

  it("forgets old finished calls", async () => {
    const call_id = callId();
    await once(call_id, async () => ({ ok: true, result: 1 }));
    await getPool().query(
      "UPDATE hub_api_forwarded_calls SET created = now() - INTERVAL '2 hours' WHERE call_id = $1",
      [call_id],
    );
    await deleteOldForwardedCallRecords();
    const { rows } = await getPool().query(
      "SELECT 1 FROM hub_api_forwarded_calls WHERE call_id = $1",
      [call_id],
    );
    expect(rows).toHaveLength(0);
  });

  it("does not keep a very large outcome, and says so to a repeat", async () => {
    const call_id = callId();
    const run = jest.fn(async () => ({
      ok: true as const,
      result: "x".repeat(1_100_000),
    }));
    const first = await once(call_id, run);
    expect((first as any).result.length).toBe(1_100_000);
    await expect(once(call_id, run)).resolves.toMatchObject({
      ok: false,
      attrs: { code: "OUTCOME_UNKNOWN" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
