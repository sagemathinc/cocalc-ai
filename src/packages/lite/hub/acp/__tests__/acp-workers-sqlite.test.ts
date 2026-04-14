import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  getAcpWorker,
  heartbeatAcpWorker,
  upsertAcpWorker,
} from "../../sqlite/acp-workers";

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_workers").run();
});

afterAll(() => {
  closeAcpDatabase();
});

describe("heartbeatAcpWorker", () => {
  it("backfills exit_requested_at when a worker heartbeats as draining", () => {
    upsertAcpWorker({
      worker_id: "worker-1",
      host_id: "host-1",
      bundle_version: "bundle-1",
      bundle_path: "/bundle",
      pid: 123,
      state: "active",
      started_at: 1000,
      last_heartbeat_at: 1000,
      last_seen_running_jobs: 0,
      exit_requested_at: null,
      stopped_at: null,
      stop_reason: null,
    });

    const before = getAcpWorker("worker-1");
    expect(before?.state).toBe("active");
    expect(before?.exit_requested_at).toBeNull();

    const after = heartbeatAcpWorker({
      worker_id: "worker-1",
      state: "draining",
      last_seen_running_jobs: 0,
    });

    expect(after?.state).toBe("draining");
    expect(after?.exit_requested_at).toEqual(expect.any(Number));
  });

  it("preserves an existing exit_requested_at for draining workers", () => {
    upsertAcpWorker({
      worker_id: "worker-2",
      host_id: "host-1",
      bundle_version: "bundle-1",
      bundle_path: "/bundle",
      pid: 123,
      state: "draining",
      started_at: 1000,
      last_heartbeat_at: 1000,
      last_seen_running_jobs: 0,
      exit_requested_at: 2000,
      stopped_at: null,
      stop_reason: null,
    });

    const after = heartbeatAcpWorker({
      worker_id: "worker-2",
      state: "draining",
      last_seen_running_jobs: 0,
    });

    expect(after?.state).toBe("draining");
    expect(after?.exit_requested_at).toBe(2000);
  });
});
