import { harnessOwner, reapAbandonedHarnesses } from "./harness-reaper";

const mockExec = jest.fn();
const mockRead = jest.fn();
jest.mock("node:child_process", () => ({
  execFile: (...args) => mockExec(...args),
}));
jest.mock("node:fs/promises", () => ({
  readFile: (...args) => mockRead(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({ podmanEnv: () => ({}) }));
jest.mock("@cocalc/backend/logger", () => () => ({
  info: jest.fn(),
  warn: jest.fn(),
}));
const boot = "00000000-0000-0000-0000-000000000000";
const container = (id: string, owner?: string) => ({
  Id: id.repeat(64),
  Labels: { "cocalc.acp.owner": owner },
});
const stat = `10 (worker (name)) ${Array(19).fill("0").join(" ")} 999 0`;
beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockImplementation(async (path) =>
    path.endsWith("boot_id") ? boot : stat,
  );
  mockExec.mockImplementation((_cmd, _args, _options, cb) => cb(null, "[]"));
});
test("owner fingerprint reads process start despite parentheses in process name", async () => {
  expect(await harnessOwner(10)).toBe(`10:${boot}:999`);
});
test("live owner is retained; reused PID is reaped by immutable container ID", async () => {
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(
      null,
      JSON.stringify([
        container("a", `10:${boot}:999`),
        container("b", `10:${boot}:998`),
      ]),
    ),
  );
  await reapAbandonedHarnesses();
  expect(mockExec).toHaveBeenCalledTimes(2);
  expect(mockExec.mock.calls[1][1]).toEqual([
    "rm",
    "--ignore",
    "--force",
    "--time",
    "0",
    "b".repeat(64),
  ]);
});
test("dead worker sidecar is removed even when stopped, without touching unlabeled containers", async () => {
  mockRead.mockImplementation(async (path) => {
    if (path.endsWith("boot_id")) return boot;
    throw Object.assign(Error("gone"), { code: "ENOENT" });
  });
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(
      null,
      JSON.stringify([container("a"), container("b", `10:${boot}:999`)]),
    ),
  );
  await reapAbandonedHarnesses();
  expect(mockExec).toHaveBeenCalledTimes(2);
  expect(mockExec.mock.calls[0][1]).toContain("--all");
});
test.each(["EACCES", "ENOENT"])(
  "boot inspection failure %s preserves containers",
  async (code) => {
    mockRead.mockRejectedValue(Object.assign(Error("unavailable"), { code }));
    mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
      cb(null, JSON.stringify([container("a", `10:${boot}:999`)])),
    );
    await reapAbandonedHarnesses();
    expect(mockExec).toHaveBeenCalledTimes(1);
  },
);
test("malformed inventory and removal failure are surfaced for later reconciliation", async () => {
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(null, "{}"),
  );
  await expect(reapAbandonedHarnesses()).rejects.toThrow("inventory");
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(null, JSON.stringify([container("b", `10:${boot}:998`)])),
  );
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(Error("failure")),
  );
  await expect(reapAbandonedHarnesses()).rejects.toThrow("failure");
});
