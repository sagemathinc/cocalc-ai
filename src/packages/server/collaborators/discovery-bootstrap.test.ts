import { bootstrapDemandDiscovery } from "./discovery-bootstrap";
import {
  readRevisionBootstrap,
  acknowledgeRevisionBootstrap,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    readRevisionBootstrap: jest.fn(),
    acknowledgeRevisionBootstrap: jest.fn(),
  }),
);
const receiver = {
  project_id: "project",
  home_bay_id: "home",
  owner_bay_id: "owner",
  lease_id: "lease",
};
const flags = [
  "COCALC_PEOPLE_DISCOVERY_BOOTSTRAP_PROTOTYPE",
  "COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE",
];
const prior = flags.map((flag) => process.env[flag]);
const discovery = jest.fn(),
  admit = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  flags.forEach((flag) => (process.env[flag] = "1"));
  (readRevisionBootstrap as jest.Mock).mockResolvedValue("durable-id");
  (acknowledgeRevisionBootstrap as jest.Mock).mockResolvedValue(true);
  discovery.mockResolvedValue({ status: "pending" });
  admit.mockResolvedValue({ admission: "accepted", job_id: "job" });
});
afterAll(() =>
  flags.forEach((flag, i) => {
    if (prior[i] === undefined) delete process.env[flag];
    else process.env[flag] = prior[i];
  }),
);
const run = () => bootstrapDemandDiscovery(receiver, { discovery, admit });
test.each(flags)(
  "disabled %s does not read or create any work",
  async (flag) => {
    delete process.env[flag];
    expect(await run()).toBe("disabled");
    expect(readRevisionBootstrap).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  },
);
test("finished or expired receiver creates no requests", async () => {
  (readRevisionBootstrap as jest.Mock).mockResolvedValue(null);
  expect(await run()).toBe("done");
  expect(discovery).not.toHaveBeenCalled();
});
test("admission reuses the durable receiver identity and acknowledges only success", async () => {
  expect(await run()).toBe("done");
  expect(admit).toHaveBeenCalledWith("durable-id");
  expect(acknowledgeRevisionBootstrap).toHaveBeenCalledWith({
    ...receiver,
    receiver_id: "durable-id",
  });
});
test("timeout retains the identity for retry", async () => {
  admit.mockRejectedValueOnce(Error("unknown"));
  await expect(run()).rejects.toThrow("unknown");
  expect(acknowledgeRevisionBootstrap).not.toHaveBeenCalled();
  expect(await run()).toBe("done");
  expect(admit.mock.calls).toEqual([["durable-id"], ["durable-id"]]);
});
test("throttling leaves bootstrap retryable", async () => {
  admit.mockResolvedValue({ admission: "throttled", retry_after_ms: 60000 });
  expect(await run()).toBe("deferred");
  expect(acknowledgeRevisionBootstrap).not.toHaveBeenCalled();
});
test("existing report avoids first-discovery work, without asserting freshness", async () => {
  discovery.mockResolvedValue({
    status: "unavailable",
    report: { coverage: "partial" },
  });
  expect(await run()).toBe("done");
  expect(admit).not.toHaveBeenCalled();
});
test("unknown host state does not replace a run", async () => {
  discovery.mockResolvedValue({ status: "unavailable" });
  expect(await run()).toBe("deferred");
  expect(admit).not.toHaveBeenCalled();
});
test("lease change during discovery inspection prevents admission", async () => {
  (readRevisionBootstrap as jest.Mock)
    .mockResolvedValueOnce("durable-id")
    .mockResolvedValueOnce(null);
  expect(await run()).toBe("deferred");
  expect(admit).not.toHaveBeenCalled();
});
