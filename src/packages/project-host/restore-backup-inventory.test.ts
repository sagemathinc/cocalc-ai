jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import rustic from "@cocalc/backend/sandbox/rustic";
import {
  listBackupIds,
  listRestoreBackups,
  MISSING_BACKUP_BUCKET_MESSAGE,
  parseRestoreBackupInventory,
} from "./restore-backup-inventory";
import { looksLikeMissingBackupBucketError } from "./backup-index-errors";

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
    timeout: expect.any(Number),
    maxSize: 100_000_000,
  });
  const { timeout } = run.mock.calls[0][1];
  expect(timeout).toBeGreaterThan(55_000);
  expect(timeout).toBeLessThanOrEqual(60_000);
});

const vanished = "c".repeat(64);
const disappearedStderr = [
  `Reading file \`snapshots/${vanished}\` failed in the backend.`,
  `path=snapshots/${vanished}: read failed NotFound (persistent) => S3Error { code: "NoSuchKey" }`,
].join("\n");

it("retries when a listed snapshot disappears (shared-repository retention)", async () => {
  run
    .mockResolvedValueOnce({ code: 1, stdout: "", stderr: disappearedStderr })
    .mockResolvedValueOnce({ code: 0, stdout: inventory(), stderr: "" });
  await expect(listRestoreBackups(opts)).resolves.toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(2);
  // The retry spends what is left of the same deadline.
  expect(run.mock.calls[1][1].timeout).toBeLessThanOrEqual(
    run.mock.calls[0][1].timeout,
  );
});

it("does not retry unrelated or repeated failures forever", async () => {
  run.mockResolvedValue({ code: 1, stdout: "", stderr: "connection reset" });
  await expect(listRestoreBackups(opts)).rejects.toThrow(
    /^restore backup inventory command failed$/,
  );
  expect(run).toHaveBeenCalledTimes(1);

  run.mockReset();
  run.mockResolvedValue({ code: 1, stdout: "", stderr: disappearedStderr });
  await expect(listRestoreBackups(opts)).rejects.toThrow(
    /^restore backup inventory command failed$/,
  );
  expect(run).toHaveBeenCalledTimes(3);
});

it("reports a missing bucket so callers refresh the profile, without raw stderr", async () => {
  run.mockResolvedValue({
    code: 1,
    stdout: "",
    stderr: 'S3Error { code: "NoSuchBucket", message: "secret-bucket-name" }',
  });
  const err = await listRestoreBackups(opts).catch((e) => e);
  expect(err.message).toBe(MISSING_BACKUP_BUCKET_MESSAGE);
  expect(err.message).not.toContain("secret-bucket-name");
  expect(looksLikeMissingBackupBucketError(err)).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
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

describe("listBackupIds", () => {
  const older = {
    ...snapshot,
    id: "b".repeat(64),
    time: "2025-12-01T00:00:00Z",
  };

  it("lists a profile repository with the bounded inventory, never the browser, oldest first", async () => {
    run.mockResolvedValue({
      code: 0,
      stdout: inventory([snapshot, older]),
      stderr: "",
    });
    const browse = jest.fn();
    await expect(listBackupIds({ ...opts, browse })).resolves.toEqual([
      { id: older.id, time: new Date(older.time) },
      { id: snapshot.id, time: new Date(snapshot.time) },
    ]);
    expect(browse).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ["snapshots", "--json"],
      expect.objectContaining({ host: snapshot.hostname, timeout: 60_000 }),
    );
  });

  it("propagates inventory failures instead of reporting no backups", async () => {
    run.mockResolvedValue({ code: 1, stdout: "", stderr: "timeout" });
    await expect(listBackupIds({ ...opts, browse: jest.fn() })).rejects.toThrow(
      /restore backup inventory/,
    );
  });

  it("browses a directory repository, which has no profile", async () => {
    const browse = jest.fn().mockResolvedValue([
      { id: "x", time: new Date(2), summary: { a: 1 } },
      { id: "y", time: new Date(1), summary: {} },
    ]);
    await expect(
      listBackupIds({ ...opts, profilePath: "/synthetic/directory", browse }),
    ).resolves.toEqual([
      { id: "y", time: new Date(1) },
      { id: "x", time: new Date(2) },
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});
