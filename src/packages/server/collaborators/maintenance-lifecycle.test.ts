/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
const schema = jest.fn(),
  outboxSchema = jest.fn(),
  outbox = jest.fn(),
  repair = jest.fn(),
  fanout = jest.fn(),
  settings = jest.fn();
jest.mock("@cocalc/backend/logger", () => () => ({ warn: jest.fn() }));
jest.mock("@cocalc/database/pool", () => () => ({}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-common",
  () => ({
    syncCollaboratorsSchema: () => schema(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-demand",
  () => ({
    syncCollaborationDemandSchema: async () => {},
    demandSchedulingEnabled: () => true,
    runCollaborationDemandActivation: async () => ({ scheduled: 0 }),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    syncCollaborationRevisionReceiverSchema: async () => {},
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({
    syncCollaborationRevisionInterestSchema: async () => {},
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-outbox",
  () => ({
    syncCollaborationRevisionOutboxSchema: () => outboxSchema(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-projection",
  () => ({
    cleanCollaborationProjections: async () => {},
    claimCollaborationProjectionJobs: async () => [],
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-access",
  () => ({
    claimCollaborationAccess: async () => [],
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({
    compactNextCollaborationProject: async () => {},
  }),
);
jest.mock("@cocalc/server/notifications/collaboration-state", () => ({
  ensureCollaborationNotificationSchema: async () => {},
}));
jest.mock("@cocalc/server/notifications/collaboration-fanout", () => ({
  runCollaborationFanoutPass: () => fanout(),
}));
jest.mock("@cocalc/server/people/invite-maintenance", () => ({
  runPeopleInviteMaintenance: async () => {},
}));
jest.mock("./invitations-runtime", () => ({
  runPeopleInvitationMaintenance: async () => {},
}));
jest.mock("./api", () => ({}));
jest.mock("./projection-batch", () => ({
  createSharedProjectionFetcher: () => jest.fn(),
}));
jest.mock("./revision-registration", () => ({
  registerProjectionRevisionReceivers: async () => ({
    armed: 0,
    deferred: 0,
    failed: 0,
  }),
}));
jest.mock("./revision-maintenance", () => ({
  runRevisionReceiverCleanup: async () => {},
  runRevisionInterestCleanup: async () => {},
}));
jest.mock("./revision-wakeup", () => ({
  runRevisionWakeupScheduling: async () => {},
}));
jest.mock("./revision-outbox-maintenance", () => ({
  runRevisionOutboxMaintenance: () => outbox(),
}));
jest.mock("./revision-repair", () => ({
  runRevisionHintRepair: () => repair(),
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));

import {
  startCollaboratorsMaintenance,
  stopCollaboratorsMaintenance,
} from "./maintenance";

const flags = [
  "COCALC_PEOPLE_DEMAND_PROTOTYPE",
  "COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE",
  "COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE",
  "COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE",
];
const previous = flags.map((flag) => process.env[flag]);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
beforeEach(() => {
  jest.useFakeTimers();
  for (const mock of [schema, outboxSchema, outbox, repair, fanout])
    mock.mockReset().mockResolvedValue(undefined);
  settings.mockReset().mockResolvedValue({ collaborators_enabled: true });
  flags.forEach((flag) => (process.env[flag] = "1"));
});
afterEach(() => {
  stopCollaboratorsMaintenance();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  flags.forEach((flag, i) => {
    if (previous[i] === undefined) delete process.env[flag];
    else process.env[flag] = previous[i];
  });
});

test("startup is idempotent and installs the opt-in schema before dispatch", async () => {
  await startCollaboratorsMaintenance();
  await startCollaboratorsMaintenance();
  expect(schema).toHaveBeenCalledTimes(1);
  expect(outboxSchema).toHaveBeenCalledTimes(1);
  expect(outbox).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(0);
  expect(outbox).toHaveBeenCalledTimes(1);
  expect(repair).toHaveBeenCalledTimes(1);
  stopCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(10000);
  expect(outbox).toHaveBeenCalledTimes(1);
});

test("outbox schema is not installed without explicit opt-in", async () => {
  delete process.env.COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE;
  await startCollaboratorsMaintenance();
  expect(outboxSchema).not.toHaveBeenCalled();
});

test("failed schema initialization is retryable and starts no timers", async () => {
  outboxSchema.mockRejectedValueOnce(Error("schema unavailable"));
  await expect(startCollaboratorsMaintenance()).rejects.toThrow(
    "schema unavailable",
  );
  expect(jest.getTimerCount()).toBe(0);
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  expect(outbox).toHaveBeenCalledTimes(1);
});

test("stop during schema installation prevents the old startup from scheduling", async () => {
  const pending = deferred();
  schema.mockReturnValueOnce(pending.promise);
  const old = startCollaboratorsMaintenance();
  stopCollaboratorsMaintenance();
  pending.resolve();
  await old;
  expect(jest.getTimerCount()).toBe(0);
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  expect(outbox).toHaveBeenCalledTimes(1);
});

test("fanout and outbox failures do not skip repair or the next pass", async () => {
  fanout.mockRejectedValueOnce(Error("delivery unavailable"));
  outbox.mockRejectedValueOnce(Error("owner unavailable"));
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  expect(repair).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(fanout).toHaveBeenCalledTimes(2);
  expect(outbox).toHaveBeenCalledTimes(2);
  expect(repair).toHaveBeenCalledTimes(2);
});

test("failure from an old startup cannot stop a newer lifecycle", async () => {
  let fail!: (error: Error) => void;
  schema.mockReturnValueOnce(new Promise<void>((_, reject) => (fail = reject)));
  const old = startCollaboratorsMaintenance();
  const rejected = expect(old).rejects.toThrow("old startup failed");
  stopCollaboratorsMaintenance();
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  fail(Error("old startup failed"));
  await rejected;
  await jest.advanceTimersByTimeAsync(1000);
  expect(outbox).toHaveBeenCalledTimes(2);
  expect(repair).toHaveBeenCalledTimes(2);
});

test("an in-flight old pass cannot resume or schedule after stop and restart", async () => {
  const pending = deferred();
  outbox.mockReturnValueOnce(pending.promise);
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  expect(outbox).toHaveBeenCalledTimes(1);
  expect(repair).not.toHaveBeenCalled();
  stopCollaboratorsMaintenance();
  await startCollaboratorsMaintenance();
  await jest.advanceTimersByTimeAsync(0);
  expect(outbox).toHaveBeenCalledTimes(2);
  expect(repair).toHaveBeenCalledTimes(1);
  pending.resolve();
  await jest.advanceTimersByTimeAsync(1000);
  expect(outbox).toHaveBeenCalledTimes(3);
  expect(repair).toHaveBeenCalledTimes(2);
});
