import { harnessOwner, reapAbandonedHarnesses } from "./harness-reaper";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockExec = jest.fn();
const mockRead = jest.fn();
const mockLstat = jest.fn();
const mockRm = jest.fn();
jest.mock("node:child_process", () => ({
  execFile: (...args) => mockExec(...args),
}));
jest.mock("node:fs/promises", () => ({
  readFile: (...args) => mockRead(...args),
  lstat: (...args) => mockLstat(...args),
  rm: (...args) => mockRm(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({ podmanEnv: () => ({}) }));
jest.mock("@cocalc/backend/logger", () => () => ({
  info: jest.fn(),
  warn: jest.fn(),
}));
const boot = "00000000-0000-0000-0000-000000000000";
const container = (id: string, owner?: string, credentialHome?: string) => ({
  Id: id.repeat(64),
  Labels: {
    "cocalc.acp.owner": owner,
    "cocalc.acp.credential-home": credentialHome,
  },
});
const stat = `10 (worker (name)) ${Array(19).fill("0").join(" ")} 999 0`;
beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockImplementation(async (path) =>
    path.endsWith("boot_id") ? boot : stat,
  );
  mockExec.mockImplementation((_cmd, _args, _options, cb) => cb(null, "[]"));
  mockLstat.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  mockRm.mockResolvedValue(undefined);
});

test("reaper removes only a generated Claude controller credential home", async () => {
  const home = join(tmpdir(), "cocalc-claude-controller-Ab12Cd");
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(
      null,
      JSON.stringify([
        container("a", `10:${boot}:998`, home),
        container("b", `10:${boot}:998`, join(tmpdir(), "unrelated-home")),
      ]),
    ),
  );
  await reapAbandonedHarnesses();
  expect(mockRm).toHaveBeenCalledTimes(1);
  expect(mockRm).toHaveBeenCalledWith(home, { recursive: true, force: true });
});

test("reaper refuses a symlinked Claude controller home", async () => {
  const home = join(tmpdir(), "cocalc-claude-controller-Ab12Cd");
  mockLstat.mockResolvedValue({
    isDirectory: () => false,
    isSymbolicLink: () => true,
  });
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(null, JSON.stringify([container("a", `10:${boot}:998`, home)])),
  );
  await expect(reapAbandonedHarnesses()).rejects.toThrow(
    "abandoned ACP sidecar",
  );
  expect(mockRm).not.toHaveBeenCalled();
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
  await expect(reapAbandonedHarnesses()).rejects.toThrow(
    "1 abandoned ACP sidecar",
  );
});

test("a failed removal does not starve other abandoned sidecars in the sweep", async () => {
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(
      null,
      JSON.stringify([
        container("a", `10:${boot}:998`),
        container("b", `10:${boot}:998`),
        container("c", `10:${boot}:999`),
      ]),
    ),
  );
  mockExec.mockImplementationOnce((_cmd, _args, _options, cb) =>
    cb(Error("stuck container")),
  );
  await expect(reapAbandonedHarnesses()).rejects.toThrow();
  expect(mockExec.mock.calls.slice(1).map((call) => call[1].at(-1))).toEqual([
    "a".repeat(64),
    "b".repeat(64),
  ]);
});

test("failed removals are retried on a later sweep with fresh owner checks", async () => {
  const inventory = JSON.stringify([
    container("a", `10:${boot}:998`),
    container("b", `10:${boot}:998`),
  ]);
  mockExec.mockImplementation((_cmd, args, _options, cb) =>
    args[0] === "ps" ? cb(null, inventory) : cb(Error("unavailable")),
  );
  await expect(reapAbandonedHarnesses()).rejects.toThrow(
    "2 abandoned ACP sidecar",
  );
  mockExec.mockClear();
  mockRead.mockClear();
  mockExec.mockImplementation((_cmd, args, _options, cb) =>
    cb(null, args[0] === "ps" ? inventory : ""),
  );
  await expect(reapAbandonedHarnesses()).resolves.toBeUndefined();
  expect(mockRead).toHaveBeenCalledTimes(4);
  expect(mockExec.mock.calls.slice(1).map((call) => call[1].at(-1))).toEqual([
    "a".repeat(64),
    "b".repeat(64),
  ]);
});
