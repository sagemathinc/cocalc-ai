import { withBackupAttempt } from "./backup-attempt";

const project_id = "00000000-0000-4000-8000-000000000001";
const record = jest.fn();
const reportingFailed = jest.fn();
const run = jest.fn();
const invoke = (enabled = true) =>
  withBackupAttempt({ enabled, project_id, record, reportingFailed, run });
beforeEach(() => {
  jest.resetAllMocks();
  record.mockResolvedValue(undefined);
});

it("does not start work before durable attempt admission", async () => {
  record.mockRejectedValue(new Error("bay unavailable"));
  await expect(invoke()).rejects.toThrow("bay unavailable");
  expect(run).not.toHaveBeenCalled();
});
it("records failure with the same attempt identity and preserves the actual job error", async () => {
  run.mockRejectedValue(new Error("inventory limit"));
  await expect(invoke()).rejects.toThrow("inventory limit");
  const initial = record.mock.calls[0][0];
  expect(initial).toMatchObject({ project_id, action: "start" });
  expect(record.mock.calls[1][0]).toEqual({ ...initial, action: "finish" });
});
it("does not mask the backup failure if failure telemetry is also unavailable", async () => {
  run.mockRejectedValue(new Error("inventory limit"));
  record
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("bay disconnected"));
  await expect(invoke()).rejects.toThrow("inventory limit");
  expect(reportingFailed).toHaveBeenCalledWith(
    expect.objectContaining({ message: "bay disconnected" }),
  );
});
it("requires protected completion instead of trusting a successful return value", async () => {
  run.mockResolvedValue({ id: "unproven" });
  await expect(invoke()).rejects.toThrow(
    "without confirming protected completion",
  );
  expect(record.mock.calls[1][0]).not.toHaveProperty("backup_id");
});
it("confirms the exact accepted snapshot before returning success", async () => {
  run.mockImplementation(async (confirm) => {
    await confirm("a".repeat(64));
    return "done";
  });
  await expect(invoke()).resolves.toBe("done");
  expect(record.mock.calls[1][0]).toEqual({
    ...record.mock.calls[0][0],
    action: "finish",
    backup_id: "a".repeat(64),
  });
});
it("retains an accepted partial backup outcome when the caller reports exclusions as an error", async () => {
  run.mockImplementation(async (confirm) => {
    await confirm("b".repeat(64));
    throw new Error("partial backup");
  });
  await expect(invoke()).rejects.toThrow("partial backup");
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls[1][0].backup_id).toBe("b".repeat(64));
});
it("does not change gate-disabled legacy execution", async () => {
  run.mockResolvedValue("legacy");
  await expect(invoke(false)).resolves.toBe("legacy");
  expect(record).not.toHaveBeenCalled();
});
