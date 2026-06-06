/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import {
  attachProjectionFeedDiagnostics,
  collectProjectionDiagnostics,
  recordProjectionAckConverged,
  recordProjectionAckFailed,
  recordProjectionAckStart,
  recordProjectionFeedEvent,
  recordProjectionHistoryGap,
  recordProjectionRepair,
  recordProjectionRepairFailure,
  resetProjectionDiagnosticsForTests,
} from "./projection-diagnostics";
import { writeAndWaitForProjection } from "./projection-ack";

class MockStream extends EventEmitter {
  private closed = false;
  private recoveryState = "ready";

  getRecoveryState() {
    return this.recoveryState;
  }

  isClosed() {
    return this.closed;
  }

  setRecoveryState(state: string) {
    this.recoveryState = state;
    this.emit("recovery-state", state);
  }

  close() {
    this.closed = true;
    this.recoveryState = "closed";
    this.emit("closed");
  }
}

beforeEach(() => {
  resetProjectionDiagnosticsForTests();
});

test("records feed lifecycle and projection events", () => {
  const stream = new MockStream();
  const cleanup = attachProjectionFeedDiagnostics({
    consumer: "projects",
    account_id: "account-id",
    stream_name: "account-feed",
    stream,
  });

  recordProjectionFeedEvent({
    consumer: "projects",
    event: { type: "project.upsert" },
    seq: 10,
  });
  recordProjectionHistoryGap({
    consumer: "projects",
    info: { requested_start_seq: 5, effective_start_seq: 8 },
  });
  recordProjectionRepair({
    consumer: "projects",
    reason: "history-gap",
    scope: "account_project_index",
  });

  stream.setRecoveryState("recovering");
  stream.close();
  cleanup();

  const diagnostics = collectProjectionDiagnostics();
  const projects = diagnostics.consumers.projects;

  expect(projects.account_id).toBe("account-id");
  expect(projects.attach_count).toBe(1);
  expect(projects.detach_count).toBe(1);
  expect(projects.event_count).toBe(1);
  expect(projects.last_event_type).toBe("project.upsert");
  expect(projects.last_seq).toBe(10);
  expect(projects.history_gap_count).toBe(1);
  expect(projects.repair_count).toBe(1);
  expect(projects.stream_recovery_state).toBe("closed");
  expect(projects.is_closed).toBe(true);
});

test("tracks pending and failed write acknowledgements", () => {
  recordProjectionAckStart({
    consumer: "account",
    id: "ack-1",
    name: "account.other_settings.foo",
  });
  recordProjectionAckStart({
    consumer: "account",
    id: "ack-2",
    name: "account.other_settings.bar",
  });
  recordProjectionAckConverged({
    consumer: "account",
    id: "ack-1",
    name: "account.other_settings.foo",
  });
  recordProjectionAckFailed({
    consumer: "account",
    id: "ack-2",
    name: "account.other_settings.bar",
    error: new Error("did not converge"),
  });
  recordProjectionRepairFailure({
    consumer: "account",
    reason: "snapshot-refresh",
    error: new Error("closed"),
  });

  const account = collectProjectionDiagnostics().consumers.account;

  expect(account.ack_count).toBe(2);
  expect(account.ack_failure_count).toBe(1);
  expect(account.repair_failure_count).toBe(1);
  expect(account.pending_acks).toEqual({});
  expect(account.last_ack_state).toBe("failed");
});

test("write acknowledgement repairs before converging", async () => {
  jest.useFakeTimers();
  try {
    let repaired = false;
    const ack = writeAndWaitForProjection({
      consumer: "notifications",
      name: "notifications.read_state.read",
      write: jest.fn(async () => undefined),
      matchesProjection: () => repaired,
      repair: jest.fn(async () => {
        repaired = true;
      }),
    });

    await Promise.resolve();
    expect(
      collectProjectionDiagnostics().consumers.notifications.pending_acks,
    ).not.toEqual({});

    await jest.advanceTimersByTimeAsync(5_000);
    await ack;

    const diagnostics = collectProjectionDiagnostics().consumers.notifications;
    expect(diagnostics.last_ack_state).toBe("converged");
    expect(diagnostics.pending_acks).toEqual({});
  } finally {
    jest.useRealTimers();
  }
});
