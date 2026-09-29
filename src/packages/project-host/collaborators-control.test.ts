/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { collaborationReconciliationControl as api } from "./collaborators-control";
import {
  requestHostedCollaborationReconciliation,
  hostedCollaborationReconciliationStatus,
} from "./collaborators";
jest.mock("./collaborators", () => ({
  requestHostedCollaborationReconciliation: jest.fn(async () => ({
    admission: "accepted",
  })),
  hostedCollaborationReconciliationStatus: jest.fn(async () => ({
    state: "unknown",
  })),
}));
const opts = {
  protocol_version: 1 as const,
  project_id: "11111111-1111-4111-8111-111111111111",
  run_id: "22222222-2222-4222-8222-222222222222",
};
const previous = process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE = "1";
});
afterAll(() => {
  if (previous === undefined)
    delete process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE;
  else process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE = previous;
});
test.each([
  "requestCollaborationReconciliation",
  "getCollaborationReconciliationStatus",
] as const)(
  "%s rejects disabled and unsupported/invalid protocol requests",
  async (method) => {
    delete process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE;
    if (method === "requestCollaborationReconciliation")
      await expect(api[method](opts)).rejects.toThrow("disabled");
    process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE = "1";
    await expect(
      api[method]({ ...opts, protocol_version: 2 as any }),
    ).rejects.toThrow("unsupported");
    await expect(api[method]({ ...opts, run_id: "invalid" })).rejects.toThrow(
      "identity",
    );
    expect(requestHostedCollaborationReconciliation).not.toHaveBeenCalled();
    expect(hostedCollaborationReconciliationStatus).not.toHaveBeenCalled();
  },
);
test("admission forwards only fixed protocol fields, not caller traversal options", async () => {
  await api.requestCollaborationReconciliation({
    ...opts,
    root: "/etc",
    limits: { entries: 999999 },
  } as any);
  expect(requestHostedCollaborationReconciliation).toHaveBeenCalledWith({
    project_id: opts.project_id,
    run_id: opts.run_id,
    expected_run_id: undefined,
  });
});
test("status does not admit work", async () => {
  expect(await api.getCollaborationReconciliationStatus(opts)).toEqual({
    state: "unknown",
  });
  expect(hostedCollaborationReconciliationStatus).toHaveBeenCalledWith({
    project_id: opts.project_id,
    run_id: opts.run_id,
  });
  expect(requestHostedCollaborationReconciliation).not.toHaveBeenCalled();
});
