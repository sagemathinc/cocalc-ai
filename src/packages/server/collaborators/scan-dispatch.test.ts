import { dispatchCollaborationScan } from "./scan-dispatch";
import {
  startCollaborationScan,
  settleCollaborationScanDiscovery,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
jest.mock("@cocalc/database/postgres/collaborators/collaborators-scan", () => ({
  startCollaborationScan: jest.fn(),
  settleCollaborationScanDiscovery: jest.fn(),
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
  (startCollaborationScan as jest.Mock).mockResolvedValue({
    job_id: "job",
    host_id: "host",
    expected_run_id: "previous",
  });
  (getRoutedHostControlClient as jest.Mock).mockResolvedValue({
    getCollaborationReconciliationStatus: status,
    requestCollaborationReconciliation: admit,
  });
  status.mockResolvedValue({ state: "unknown" });
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
test("timeout does not settle or retry with a fresh identity", async () => {
  admit.mockRejectedValue(Error("timeout"));
  await expect(dispatchCollaborationScan(request, authority)).rejects.toThrow(
    "timeout",
  );
  expect(admit).toHaveBeenCalledTimes(1);
  expect(settleCollaborationScanDiscovery).not.toHaveBeenCalled();
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
