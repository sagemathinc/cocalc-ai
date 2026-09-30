import { dispatchCollaborationScan } from "./scan-dispatch";
import {
  startCollaborationScan,
  settleCollaborationScanDiscovery,
  claimCollaborationScanDispatch,
  releaseCollaborationScanDispatch,
  adoptCollaborationScanPredecessor,
  deferCollaborationScanDispatch,
  markCollaborationScanHostRequest,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
jest.mock("@cocalc/database/postgres/collaborators/collaborators-scan", () => ({
  startCollaborationScan: jest.fn(),
  settleCollaborationScanDiscovery: jest.fn(),
  claimCollaborationScanDispatch: jest.fn(),
  releaseCollaborationScanDispatch: jest.fn(),
  adoptCollaborationScanPredecessor: jest.fn(),
  deferCollaborationScanDispatch: jest.fn(),
  markCollaborationScanHostRequest: jest.fn(),
}));
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: jest.fn(),
}));
const request = {
  project_id: "project",
  account_id: "account",
  request_id: "request",
  job_id: "job",
};
const authority = { owning_bay_id: "owner" };
const status = jest.fn(),
  admit = jest.fn();
const prior = process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = "1";
  (claimCollaborationScanDispatch as jest.Mock).mockResolvedValue("lease");
  (markCollaborationScanHostRequest as jest.Mock).mockResolvedValue(true);
  (startCollaborationScan as jest.Mock).mockResolvedValue({
    job_id: "job",
    host_id: "host",
    expected_run_id: "previous",
  });
  (getRoutedHostControlClient as jest.Mock).mockResolvedValue({
    getCollaborationReconciliationStatus: status,
    requestCollaborationReconciliation: admit,
  });
  status.mockResolvedValue({ state: "unknown", current_run_id: "previous" });
  admit.mockResolvedValue({ admission: "accepted", run_id: "job" });
});
afterAll(() => {
  if (prior === undefined)
    delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  else process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE = prior;
});
test("disabled never prepares work", async () => {
  delete process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE;
  await expect(dispatchCollaborationScan(request, authority)).rejects.toThrow(
    "disabled",
  );
  expect(startCollaborationScan).not.toHaveBeenCalled();
});
test("busy lease makes no host calls", async () => {
  (claimCollaborationScanDispatch as jest.Mock).mockResolvedValue(null);
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "deferred",
  });
  expect(getRoutedHostControlClient).not.toHaveBeenCalled();
});
test("initial host census is durably adopted before replacement", async () => {
  (startCollaborationScan as jest.Mock).mockResolvedValue({
    job_id: "job",
    host_id: "host",
  });
  status.mockResolvedValue({ state: "unknown", current_run_id: "old" });
  (adoptCollaborationScanPredecessor as jest.Mock).mockResolvedValue(true);
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "running",
  });
  expect(adoptCollaborationScanPredecessor).toHaveBeenCalledWith(
    {
      project_id: "project",
      job_id: "job",
      token: "lease",
      predecessor: "old",
    },
    { ...authority, host_id: "host" },
  );
  expect(admit).toHaveBeenCalledWith(
    expect.objectContaining({ expected_run_id: "old" }),
  );
});
test("unknown run admits exact persistent identity and predecessor", async () => {
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "running",
  });
  expect(admit).toHaveBeenCalledWith({
    protocol_version: 1,
    project_id: "project",
    run_id: "job",
    expected_run_id: "previous",
  });
  expect(getRoutedHostControlClient).toHaveBeenCalledWith({
    host_id: "host",
    timeout: 30000,
  });
});
test("a raced predecessor reconciliation cannot submit work", async () => {
  status.mockResolvedValue({ state: "unknown", current_run_id: "other" });
  (adoptCollaborationScanPredecessor as jest.Mock).mockResolvedValue(false);
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "deferred",
  });
  expect(markCollaborationScanHostRequest).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});
test("timeout does not settle or retry with a fresh identity", async () => {
  admit.mockRejectedValue(Error("timeout"));
  await expect(dispatchCollaborationScan(request, authority)).rejects.toThrow(
    "timeout",
  );
  expect(admit).toHaveBeenCalledTimes(1);
  expect(settleCollaborationScanDiscovery).not.toHaveBeenCalled();
});
test("cancellation or an expired lease during the read probe prevents submission", async () => {
  (markCollaborationScanHostRequest as jest.Mock).mockResolvedValue(false);
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "deferred",
  });
  expect(status).toHaveBeenCalledTimes(1);
  expect(admit).not.toHaveBeenCalled();
});
test("read probe failure never crosses the durable submission boundary", async () => {
  status.mockRejectedValue(Error("host unavailable"));
  await expect(dispatchCollaborationScan(request, authority)).rejects.toThrow(
    "host unavailable",
  );
  expect(markCollaborationScanHostRequest).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});
test.each([
  [
    { admission: "throttled", retry_after_ms: 120000 },
    "host_throttled",
    120000,
  ],
  [{ admission: "deferred", reason: "BUSY" }, "host_busy", 30000],
  [
    { admission: "deferred", reason: "REPORT_PENDING" },
    "report_pending",
    30000,
  ],
  [
    { admission: "deferred", reason: "/private/host/path" },
    "host_deferred",
    30000,
  ],
])(
  "persists bounded safe host deferral %j",
  async (reply, reason, retry_after_ms) => {
    admit.mockResolvedValue({ ...reply, run_id: "job" });
    expect(await dispatchCollaborationScan(request, authority)).toEqual({
      state: "deferred",
    });
    expect(deferCollaborationScanDispatch).toHaveBeenCalledWith(
      {
        project_id: "project",
        job_id: "job",
        token: "lease",
        reason,
        retry_after_ms,
      },
      { ...authority, host_id: "host" },
    );
    expect(releaseCollaborationScanDispatch).toHaveBeenCalled();
  },
);
test("a busy predecessor defers this job without claiming its run identity", async () => {
  admit.mockResolvedValue({
    admission: "throttled",
    run_id: "other",
    retry_after_ms: 60000,
  });
  await expect(dispatchCollaborationScan(request, authority)).resolves.toEqual({
    state: "deferred",
  });
  expect(deferCollaborationScanDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ job_id: "job", reason: "host_throttled" }),
    { ...authority, host_id: "host" },
  );
});

test("discovered with pending candidates does not settle", async () => {
  status.mockResolvedValue({
    state: "discovered",
    run_id: "job",
    pending_candidates: 1,
  });
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "running",
  });
  expect(admit).not.toHaveBeenCalled();
  expect(settleCollaborationScanDiscovery).not.toHaveBeenCalled();
});
test("settles only exact discovered run with no pending candidates", async () => {
  status.mockResolvedValue({
    state: "discovered",
    run_id: "job",
    pending_candidates: 0,
  });
  (settleCollaborationScanDiscovery as jest.Mock).mockResolvedValue(true);
  expect(await dispatchCollaborationScan(request, authority)).toEqual({
    state: "discovered",
  });
  expect(settleCollaborationScanDiscovery).toHaveBeenCalledWith(
    { project_id: "project", job_id: "job", state: "discovered" },
    { ...authority, host_id: "host" },
  );
});
