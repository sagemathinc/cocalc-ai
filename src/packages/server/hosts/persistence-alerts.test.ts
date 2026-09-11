import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { ensureProjectHostMetricsSamplesSchema } from "@cocalc/database/postgres/project-host-metrics";
import { runConatPersistAlertCheck } from "./availability";

const mockAdminAlert = jest.fn();
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockAdminAlert(...args),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  ...jest.requireActual("@cocalc/database/pool"),
  withSessionAdvisoryLock: jest.fn(async ({ fn }) => await fn()),
}));

const ids = Array.from(
  { length: 5 },
  (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
);
const GIB = 1024 ** 3;

describe("persistence notification history query", () => {
  beforeAll(async () => {
    await getPool().query(`CREATE TABLE IF NOT EXISTS project_hosts (
      id UUID PRIMARY KEY, name TEXT, status TEXT, deleted TIMESTAMPTZ,
      last_seen TIMESTAMPTZ, metadata JSONB, public_url TEXT
    )`);
    await ensureProjectHostMetricsSamplesSchema();
  });
  afterEach(async () => {
    await getPool().query(
      "DELETE FROM project_host_metrics_samples WHERE host_id = ANY($1::uuid[])",
      [ids],
    );
    await getPool().query(
      "DELETE FROM project_hosts WHERE id = ANY($1::uuid[])",
      [ids],
    );
    mockAdminAlert.mockClear();
  });

  async function host(
    index: number,
    ageMinutes = 0,
    rss = 3 * GIB,
    status = "running",
  ) {
    await getPool().query(
      "INSERT INTO project_hosts (id, name, status, last_seen) VALUES ($1, $2, $3, NOW())",
      [ids[index], `host-${index}`, status],
    );
    const now = Date.now();
    for (let i = 0; i < 13; i++) {
      const collected_at = new Date(
        now - (i + ageMinutes) * 60_000,
      ).toISOString();
      await getPool().query(
        "INSERT INTO project_host_metrics_samples (host_id, collected_at, conat_persist) VALUES ($1,$2,$3)",
        [
          ids[index],
          collected_at,
          {
            schema_version: 1,
            collected_at,
            available: true,
            ready: true,
            pid: 10,
            rss_bytes: rss,
            open_streams: 8000,
          },
        ],
      );
    }
  }

  it("notifies fresh sustained pressure only, with distinct per-host delivery keys", async () => {
    await host(0);
    await host(1, 8); // Stale despite otherwise sufficient pressure history.
    await host(2, 0, GIB); // Many streams, but no pressure.
    await host(3, 0, 5 * GIB);
    await host(4, 0, 5 * GIB, "off");
    expect(await runConatPersistAlertCheck()).toBe(2);
    expect(mockAdminAlert).toHaveBeenCalledTimes(2);
    expect(mockAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: `Project-host persistence warning: ${ids[0]} (rss)`,
        body: expect.stringContaining("host-0"),
        dedupMinutes: 240,
        dedupBySubject: true,
      }),
    );
    expect(mockAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: `Project-host persistence critical: ${ids[3]} (rss)`,
        dedupMinutes: 60,
      }),
    );
    expect(withSessionAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ lockKey: "project-host-persistence-alerts" }),
    );
  });

  it("does not run a second pass when another worker owns the lock", async () => {
    jest.mocked(withSessionAdvisoryLock).mockResolvedValueOnce(undefined);
    expect(await runConatPersistAlertCheck()).toBe(0);
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("does not bridge a null/missing recent history into an alert", async () => {
    await host(0);
    await getPool().query(
      "UPDATE project_host_metrics_samples SET conat_persist = NULL WHERE host_id=$1",
      [ids[0]],
    );
    expect(await runConatPersistAlertCheck()).toBe(0);
  });
});
