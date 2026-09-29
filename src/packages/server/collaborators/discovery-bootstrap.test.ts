import { bootstrapDemandDiscovery } from "./discovery-bootstrap";
import {
  readRevisionBootstrap,
  acknowledgeRevisionBootstrap,
  readOrCreateRevisionRepair,
  acknowledgeRevisionRepair,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    readRevisionBootstrap: jest.fn(),
    acknowledgeRevisionBootstrap: jest.fn(),
    readOrCreateRevisionRepair: jest.fn(),
    acknowledgeRevisionRepair: jest.fn(),
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
  (readOrCreateRevisionRepair as jest.Mock).mockResolvedValue(null);
  (acknowledgeRevisionRepair as jest.Mock).mockResolvedValue(true);
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
test("returning demand repairs an old owner report rather than restarting an hourly wait", async () => {
  discovery.mockResolvedValue({
    status: "unavailable",
    report: { coverage: "complete" },
    updated_at: Date.now() - 2 * 60 * 60_000,
  });
  expect(await run()).toBe("done");
  expect(admit).toHaveBeenCalledWith("durable-id");
});
test("recent owner report avoids redundant return-time repair", async () => {
  discovery.mockResolvedValue({
    status: "complete",
    report: { coverage: "complete" },
    updated_at: Date.now(),
  });
  expect(await run()).toBe("done");
  expect(admit).not.toHaveBeenCalled();
});
test("lease change during discovery inspection prevents admission", async () => {
  (readRevisionBootstrap as jest.Mock)
    .mockResolvedValueOnce("durable-id")
    .mockResolvedValueOnce(null);
  expect(await run()).toBe("deferred");
  expect(admit).not.toHaveBeenCalled();
});

test("due repair reuses admission and retains its identity after unknown outcome", async () => {
  (readRevisionBootstrap as jest.Mock).mockResolvedValue(null);
  (readOrCreateRevisionRepair as jest.Mock).mockResolvedValue("repair-id");
  admit.mockRejectedValueOnce(Error("unknown"));
  await expect(run()).rejects.toThrow("unknown");
  expect(acknowledgeRevisionRepair).not.toHaveBeenCalled();
  expect(await run()).toBe("done");
  expect(admit.mock.calls).toEqual([["repair-id"], ["repair-id"]]);
  expect(discovery).not.toHaveBeenCalled();
  expect(acknowledgeRevisionRepair).toHaveBeenCalledWith({
    ...receiver,
    request_id: "repair-id",
  });
});

test("throttled repair stays due; stale acknowledgment does not report done", async () => {
  (readRevisionBootstrap as jest.Mock).mockResolvedValue(null);
  (readOrCreateRevisionRepair as jest.Mock).mockResolvedValue("repair-id");
  admit.mockResolvedValueOnce({
    admission: "throttled",
    retry_after_ms: 60000,
  });
  expect(await run()).toBe("deferred");
  expect(acknowledgeRevisionRepair).not.toHaveBeenCalled();
  (acknowledgeRevisionRepair as jest.Mock).mockResolvedValue(false);
  expect(await run()).toBe("deferred");
});
