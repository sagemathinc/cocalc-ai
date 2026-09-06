const query = jest.fn();
const release = jest.fn();
const poolQuery = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQuery, connect }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-test",
}));
jest.mock("./outcomes", () => ({ ensureBackupOutcomeSchema: jest.fn() }));
jest.mock("@cocalc/backend/backup-producer-evidence", () => ({
  validateBackupOutcomeReceipt: jest.fn((value) => value),
}));
jest.mock("@cocalc/backend/backup-exclusion-report", () => ({
  backupReportHeaderSha256: () => "verified-digest",
}));
import { getHostBackupAttempt, recordBackupAttempt } from "./attempts";

const project_id = "00000000-0000-4000-8000-000000000001";
const host_id = "00000000-0000-4000-8000-000000000002";
const attempt_id = "00000000-0000-4000-8000-000000000003";
const backup_id = "b".repeat(64);
const identity = { project_id, host_id, attempt_id };
beforeEach(() => {
  jest.clearAllMocks();
  poolQuery.mockResolvedValue({ rows: [] });
  query.mockImplementation(async (sql) => {
    if (sql.startsWith("SELECT host_id")) return { rows: [{ host_id }] };
    if (sql.startsWith("SELECT receipt,"))
      return {
        rows: [
          {
            receipt_sha256: "verified-digest",
            receipt: {
              producer: {
                binding: { backup_id },
                outcome: "partial_policy_exclusions",
              },
            },
          },
        ],
      };
    return { rows: [] };
  });
});
it("bounds history to a single latest row and does not reset duplicate-start completion", async () => {
  await recordBackupAttempt({ ...identity, action: "start" });
  expect(query.mock.calls[0][0]).toBe("BEGIN");
  expect(query.mock.calls[1][0]).toContain("FOR SHARE");
  const [sql, params] = query.mock.calls[2];
  expect(sql).toContain("ON CONFLICT (project_id) DO UPDATE");
  expect(sql).toContain(
    "project_backup_latest_attempts.attempt_id<>EXCLUDED.attempt_id",
  );
  expect(params).toEqual([project_id, host_id, attempt_id]);
  expect(query).toHaveBeenLastCalledWith("COMMIT");
});
it("fences a failure against both newer attempts and previously confirmed completion", async () => {
  await recordBackupAttempt({ ...identity, action: "finish" });
  const [sql, params] = query.mock.calls[2];
  expect(sql).toContain("host_id=$2::UUID");
  expect(sql).toContain("attempt_id=$3::UUID AND outcome='unconfirmed'");
  expect(params).toEqual([project_id, host_id, attempt_id, "failed", null]);
});
it("derives partial/success from the protected receipt, not a client status", async () => {
  await recordBackupAttempt({ ...identity, action: "finish", backup_id });
  const [sql, params] = query.mock.calls[3];
  expect(sql).toContain("UPDATE project_backup_latest_attempts");
  expect(params).toEqual([
    project_id,
    host_id,
    attempt_id,
    "partial_policy_exclusions",
    backup_id,
  ]);
});
it("rejects missing completion evidence", async () => {
  query.mockImplementation(async (sql) => ({
    rows: sql.startsWith("SELECT host_id") ? [{ host_id }] : [],
  }));
  await expect(
    recordBackupAttempt({ ...identity, action: "finish", backup_id }),
  ).rejects.toThrow("no protected completion receipt");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
    false,
  );
});
it("rejects changed placement before writing anything", async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(
    recordBackupAttempt({ ...identity, action: "start" }),
  ).rejects.toThrow("placement or owning bay changed");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([
  {},
  { action: "other" },
  { action: "start", backup_id },
  { attempt_id: "bad" },
  { host_id: undefined },
])("rejects malformed updates %j before DB access", async (update) => {
  await expect(
    recordBackupAttempt({ ...identity, ...update } as any),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
it("does not expose status or confuse removed placement with no attempts", async () => {
  await expect(getHostBackupAttempt(identity)).rejects.toThrow(
    "placement or owning bay changed",
  );
  poolQuery.mockResolvedValue({ rows: [{ attempt_id: null }] });
  await expect(getHostBackupAttempt(identity)).resolves.toBeNull();
});
it("returns only bounded status metadata, never a host id or raw error log", async () => {
  poolQuery.mockResolvedValue({
    rows: [
      {
        ...identity,
        outcome: "failed",
        backup_id: null,
        started_at: new Date("2026-09-06T00:00:00Z"),
        finished_at: null,
      },
    ],
  });
  expect(await getHostBackupAttempt(identity)).toEqual({
    project_id,
    attempt_id,
    outcome: "failed",
    backup_id: null,
    started_at: "2026-09-06T00:00:00.000Z",
    finished_at: null,
  });
  const [sql, params] = poolQuery.mock.calls.at(-1)!;
  expect(sql).toContain("p.host_id=$3::UUID");
  expect(sql).toContain("COALESCE(p.owning_bay_id,$2)=$2");
  expect(params).toEqual([project_id, "bay-test", host_id]);
});
