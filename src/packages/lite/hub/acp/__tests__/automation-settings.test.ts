import { initAcpDatabase } from "../../sqlite/acp-database";
import {
  getAcpAutomationById,
  upsertAcpAutomation as legacySave,
  upsertAcpAutomation,
  toAutomationRecord,
} from "../../sqlite/acp-automations";
import {
  assertAutomationRequestCurrent,
  automationSettingsRevision,
  humanAutomationSettings,
  withCurrentAutomationSettings,
} from "../automation-settings";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";

beforeAll(() => initAcpDatabase({ filename: ":memory:" }));

function create() {
  return upsertAcpAutomation({
    automation_id: "automation",
    project_id: "project",
    path: "a.chat",
    thread_id: "thread",
    ...humanAutomationSettings("P"),
    enabled: true,
    status: "active",
    unacknowledged_runs: 0,
    prompt: "work",
  });
}
function queued(row: ReturnType<typeof create>): AcpRequest {
  return {
    project_id: row.project_id,
    account_id: row.account_id,
    prompt: "work",
    chat: {
      project_id: row.project_id,
      path: row.path,
      thread_id: row.thread_id,
      sender_id: "automation",
      message_date: "now",
      automation_id: row.automation_id,
      automation_revision: automationSettingsRevision(row),
    },
  };
}

it("transfers responsibility and invalidates queued revisions, not running snapshots", () => {
  const first = create();
  const running = queued(first);
  assertAutomationRequestCurrent(running, first);
  const next = upsertAcpAutomation({
    ...first,
    ...humanAutomationSettings("Q"),
  });
  expect(next.account_id).toBe("Q");
  expect(() => assertAutomationRequestCurrent(running, next)).toThrow(
    "stale queued",
  );
  expect(running.account_id).toBe("P");
  expect(() =>
    assertAutomationRequestCurrent(queued(next), next),
  ).not.toThrow();
  expect(toAutomationRecord(next)?.settings_revision).toBe(
    next.settings_revision,
  );
});

it("status writes, acknowledgments and reads do not transfer responsibility or revision", () => {
  const first = create();
  const updated = upsertAcpAutomation({
    ...first,
    status: "running",
    updated_at: first.updated_at + 1,
    last_acknowledged_at: Date.now(),
    unacknowledged_runs: 0,
  });
  expect(updated.account_id).toBe("P");
  expect(updated.settings_revision).toBe(first.settings_revision);
  expect(() =>
    assertAutomationRequestCurrent(
      queued(first),
      getAcpAutomationById("automation"),
    ),
  ).not.toThrow();
});

it("pausing/resuming and identical settings saves cannot resurrect an obsolete revision", () => {
  const first = create();
  const paused = upsertAcpAutomation({
    ...first,
    ...humanAutomationSettings("P"),
    enabled: false,
  });
  const resumed = upsertAcpAutomation({
    ...paused,
    ...humanAutomationSettings("P"),
    enabled: true,
  });
  expect(() => assertAutomationRequestCurrent(queued(first), resumed)).toThrow(
    "stale queued",
  );
  const unstamped = queued(resumed);
  delete unstamped.chat!.automation_revision;
  expect(() => assertAutomationRequestCurrent(unstamped, resumed)).toThrow(
    "stale queued",
  );
});

it("preserves historical ownership until the next human save", () => {
  const old = legacySave({
    ...create(),
    automation_id: "historical",
    path: "old.chat",
    account_id: "historical-owner",
  });
  expect(getAcpAutomationById(old.automation_id)?.account_id).toBe(
    "historical-owner",
  );
  expect(() => assertAutomationRequestCurrent(queued(old), old)).not.toThrow();
});

it("rejects missing accounts, deleted automations and forged queued principals", () => {
  const row = create();
  expect(() => humanAutomationSettings("")).toThrow("Authenticated human");
  expect(() => assertAutomationRequestCurrent(queued(row))).toThrow(
    "stale queued",
  );
  expect(() =>
    assertAutomationRequestCurrent({ ...queued(row), account_id: "Q" }, row),
  ).toThrow("stale queued");
});

it("checks the saved revision before invoking enqueue and rolls back failed enqueue writes", () => {
  const first = create();
  const next = upsertAcpAutomation({
    ...first,
    ...humanAutomationSettings("Q"),
  });
  const enqueue = jest.fn();
  expect(() => withCurrentAutomationSettings(queued(first), enqueue)).toThrow(
    "stale queued",
  );
  expect(enqueue).not.toHaveBeenCalled();
  expect(() =>
    withCurrentAutomationSettings(queued(next), () => {
      upsertAcpAutomation({ ...next, status: "running" });
      throw new Error("enqueue failed");
    }),
  ).toThrow("enqueue failed");
  expect(getAcpAutomationById(next.automation_id)?.status).toBe("active");
  expect(withCurrentAutomationSettings(queued(next), () => "accepted")).toBe(
    "accepted",
  );
});
