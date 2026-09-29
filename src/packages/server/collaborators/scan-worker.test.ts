import { runCollaborationScanPass } from "./scan-worker";
import {
  listCollaborationScanDispatchCandidates,
  listCollaborationScanRetirementCandidates,
  retireExpiredQueuedCollaborationScan,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { dispatchCollaborationScan } from "./scan-dispatch";
jest.mock("@cocalc/database/postgres/collaborators/collaborators-scan", () => ({
  listCollaborationScanDispatchCandidates: jest.fn(),
  listCollaborationScanRetirementCandidates: jest.fn(),
  retireExpiredQueuedCollaborationScan: jest.fn(),
}));
jest.mock("./scan-dispatch", () => ({ dispatchCollaborationScan: jest.fn() }));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
const prior = process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
const request = {
  project_id: "project",
  job_id: "job",
  account_id: "account",
  request_id: "request",
};
beforeEach(() => {
  jest.resetAllMocks();
  process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
  (listCollaborationScanRetirementCandidates as jest.Mock).mockResolvedValue(
    [],
  );
  (listCollaborationScanDispatchCandidates as jest.Mock).mockResolvedValue([
    request,
  ]);
  (dispatchCollaborationScan as jest.Mock).mockResolvedValue({
    state: "running",
  });
});
afterAll(() => {
  if (prior === undefined)
    delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  else process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = prior;
});
test("disabled does not query", async () => {
  delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  expect((await runCollaborationScanPass()).attempted).toBe(0);
  expect(listCollaborationScanDispatchCandidates).not.toHaveBeenCalled();
});
test("caps sequential attempts and preserves unknown outcomes", async () => {
  (listCollaborationScanDispatchCandidates as jest.Mock).mockResolvedValue(
    Array(30).fill(request),
  );
  (dispatchCollaborationScan as jest.Mock).mockRejectedValueOnce(
    Error("timeout"),
  );
  expect(await runCollaborationScanPass()).toEqual({
    attempted: 20,
    unknown: 1,
    pending: 19,
    deferred: 0,
    discovered: 0,
    retired: 0,
    retirement_errors: 0,
  });
  expect(dispatchCollaborationScan).toHaveBeenCalledWith(request, {
    owning_bay_id: "owner",
  });
});
test("disable between steps stops the pass", async () => {
  (listCollaborationScanDispatchCandidates as jest.Mock).mockResolvedValue([
    request,
    request,
  ]);
  (dispatchCollaborationScan as jest.Mock).mockImplementation(async () => {
    delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
    return { state: "discovered" };
  });
  expect((await runCollaborationScanPass()).attempted).toBe(1);
  expect(listCollaborationScanRetirementCandidates).not.toHaveBeenCalled();
});
test("retirement is bounded and a fenced job does not stop its peers", async () => {
  (listCollaborationScanRetirementCandidates as jest.Mock).mockResolvedValue(
    Array(30).fill(request),
  );
  (retireExpiredQueuedCollaborationScan as jest.Mock)
    .mockResolvedValue(true)
    .mockRejectedValueOnce(Error("rehoming"));
  expect(await runCollaborationScanPass()).toMatchObject({
    retired: 19,
    retirement_errors: 1,
  });
  expect(retireExpiredQueuedCollaborationScan).toHaveBeenCalledTimes(20);
});
test("overlapping pass skips work and guard is released after selection failure", async () => {
  let finish!: (value: unknown) => void;
  (listCollaborationScanDispatchCandidates as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = runCollaborationScanPass();
  expect((await runCollaborationScanPass()).attempted).toBe(0);
  finish([]);
  await first;
  (listCollaborationScanDispatchCandidates as jest.Mock).mockRejectedValueOnce(
    Error("database"),
  );
  await expect(runCollaborationScanPass()).rejects.toThrow("database");
  expect((await runCollaborationScanPass()).attempted).toBe(1);
});
