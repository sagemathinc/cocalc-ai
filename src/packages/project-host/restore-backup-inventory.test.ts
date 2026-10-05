jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import rustic from "@cocalc/backend/sandbox/rustic";
import {
  listRestoreBackups,
  parseRestoreBackupInventory,
} from "./restore-backup-inventory";

const run = rustic as jest.Mock;
const projectId = "11111111-1111-4111-8111-111111111111";
const opts = { projectId, profilePath: "/synthetic/repo.toml" };
const snapshot = {
  id: "a".repeat(64),
  hostname: `project-${projectId}`,
  time: "2026-01-01T00:00:00Z",
};
const inventory = (snapshots = [snapshot]) =>
  JSON.stringify([{ group_key: {}, snapshots }]);

beforeEach(() => run.mockReset());

it("uses bounded native project-filtered inventory without a browser", async () => {
  run.mockResolvedValue({ code: 0, stdout: inventory(), stderr: "" });
  await expect(listRestoreBackups(opts)).resolves.toEqual([
    { id: snapshot.id, time: new Date(snapshot.time), summary: {} },
  ]);
  expect(run).toHaveBeenCalledWith(["snapshots", "--json"], {
    repo: opts.profilePath,
    host: snapshot.hostname,
    timeout: 60_000,
    maxSize: 100_000_000,
  });
});

it("filters other projects and backup-index snapshots and omits raw metadata", () => {
  const snapshots = [
    snapshot,
    { ...snapshot, hostname: "project-other" },
    { ...snapshot, hostname: `${snapshot.hostname}-index` },
  ];
  expect(parseRestoreBackupInventory(inventory(snapshots), projectId)).toEqual([
    { id: snapshot.id, time: new Date(snapshot.time), summary: {} },
  ]);
});

it.each([
  "",
  "{",
  "{}",
  "null",
  "[{}]",
  inventory([{ ...snapshot, id: "bad" }]),
  inventory([{ ...snapshot, time: "bad" }]),
  inventory([{ ...snapshot, hostname: undefined } as any]),
])(
  "rejects invalid inventory rather than treating it as empty: %s",
  (stdout) => {
    expect(() => parseRestoreBackupInventory(stdout, projectId)).toThrow(
      "invalid restore backup inventory",
    );
  },
);

it("accepts empty and tuple-grouped inventories", () => {
  expect(parseRestoreBackupInventory("[]", projectId)).toEqual([]);
  expect(
    parseRestoreBackupInventory(JSON.stringify([[{}, [snapshot]]]), projectId),
  ).toHaveLength(1);
});

it.each([
  { code: 0, stdout: "[]", stderr: "", truncated: true },
  { code: 1, stdout: "[]", stderr: "access denied: secret" },
  {
    code: 1,
    stdout: "",
    stderr: "No repository config file found",
    truncated: true,
  },
])("does not treat failed/truncated output as empty", async (output) => {
  run.mockResolvedValue(output);
  await expect(listRestoreBackups(opts)).rejects.toThrow(
    /restore backup inventory/,
  );
});

it("accepts a genuinely missing repository without initializing it", async () => {
  run.mockResolvedValue({
    code: 1,
    stdout: "",
    stderr: "No repository config file found",
  });
  await expect(listRestoreBackups(opts)).resolves.toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});

it("redacts execution failures and rejects directory repository auto-initialization", async () => {
  run.mockRejectedValue(Error("secret config and credentials"));
  await expect(listRestoreBackups(opts)).rejects.toThrow(
    /^restore backup inventory command failed$/,
  );
  run.mockClear();
  await expect(
    listRestoreBackups({ ...opts, profilePath: "/synthetic/directory" }),
  ).rejects.toThrow("requires a repository profile");
  expect(run).not.toHaveBeenCalled();
});
