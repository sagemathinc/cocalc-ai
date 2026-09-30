import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { upsertProject } from "./sqlite/projects";
import { __test__, startRuntimeArtifactMaintenance } from "./upgrade";

let base: string;
let root: string;
let proc: string;
const oldData = process.env.COCALC_DATA;
const oldDatabase = process.env.COCALC_LITE_SQLITE_FILENAME;
const oldRuntime = process.env.COCALC_PODMAN_RUNTIME_DIR;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tools-retention-"));
  root = path.join(base, "tools");
  proc = path.join(base, "proc");
  fs.mkdirSync(root);
  fs.mkdirSync(proc);
  process.env.COCALC_DATA = path.join(base, "data");
  process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
  process.env.COCALC_PODMAN_RUNTIME_DIR = base;
  closeDatabase();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeDatabase();
  if (oldData === undefined) delete process.env.COCALC_DATA;
  else process.env.COCALC_DATA = oldData;
  if (oldDatabase === undefined) delete process.env.COCALC_LITE_SQLITE_FILENAME;
  else process.env.COCALC_LITE_SQLITE_FILENAME = oldDatabase;
  if (oldRuntime === undefined) delete process.env.COCALC_PODMAN_RUNTIME_DIR;
  else process.env.COCALC_PODMAN_RUNTIME_DIR = oldRuntime;
  fs.rmSync(base, { recursive: true, force: true });
});

function versions() {
  for (let i = 0; i < 7; i++) {
    const dir = path.join(root, `v${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "payload"), "tools");
    fs.utimesSync(dir, 100 + i, 100 + i);
  }
  fs.symlinkSync(path.join(root, "v6"), path.join(root, "current"));
  fs.symlinkSync(path.join(root, "v1"), path.join(root, "previous"));
}

function mounted(version: string) {
  fs.mkdirSync(path.join(proc, "123"));
  fs.writeFileSync(
    path.join(proc, "123", "mountinfo"),
    `12 1 8:1 ${root}/${version} /opt/cocalc/bin2 ro - ext4 /dev/root rw\n`,
  );
}

function podman(
  mounts: { Source: string; Destination?: string }[] = [],
  pid = 0,
) {
  return jest.fn(async (_cmd: string, args: string[], opts?: any) => {
    expect(opts.env).toBeDefined();
    return {
      stdout:
        args[0] === "ps"
          ? "container-1\n"
          : JSON.stringify({ id: "container-1", pid, mounts }) + "\n",
      stderr: "",
    };
  });
}

it("prunes only unreferenced versions while containers remain running", async () => {
  versions();
  mounted("v2");
  upsertProject({
    project_id: "starting-project",
    state: "starting",
    tools_version: "v3",
  });
  const run = podman([{ Source: path.join(root, "v4") }]);
  const refs = await __test__.referencedToolsVersions(root, proc, run);
  expect(refs.sort()).toEqual(["v2", "v3", "v4"]);
  expect(run.mock.calls[0][1]).toEqual(["ps", "-aq", "--no-trunc"]);
  await __test__.pruneVersionDirs({
    root,
    currentLink: path.join(root, "current"),
    desiredDir: path.join(root, "v6"),
    protectedVersions: refs,
    keep: 2,
    keepRecent: true,
  });
  expect(fs.readdirSync(root).sort()).toEqual([
    "current",
    "previous",
    "v1",
    "v2",
    "v3",
    "v4",
    "v5",
    "v6",
  ]);
});

it("keeps the actual old mount when Podman records a now-retargeted current link", async () => {
  versions();
  mounted("v2");
  const refs = await __test__.referencedToolsVersions(
    root,
    proc,
    podman(
      [{ Source: path.join(root, "current"), Destination: "/opt/cocalc/bin2" }],
      123,
    ),
  );
  expect(refs.sort()).toEqual(["v2", "v6"]);
});

it("retains tools if a live alias mount cannot be mapped to a concrete version", async () => {
  versions();
  mounted("v2");
  await expect(
    __test__.referencedToolsVersions(
      root,
      proc,
      podman(
        [{ Source: path.join(root, "current"), Destination: "/other/mount" }],
        123,
      ),
    ),
  ).rejects.toThrow("unable to resolve live tools alias");
});

it("retains every installed version when reference discovery fails", async () => {
  versions();
  const refs = await __test__.protectedArtifactVersions(
    { artifact: "tools", desiredVersion: "v6", root },
    async () => {
      throw Error("podman unavailable");
    },
  );
  await __test__.pruneVersionDirs({
    root,
    currentLink: path.join(root, "current"),
    desiredDir: path.join(root, "v6"),
    protectedVersions: refs,
    keep: 1,
    keepRecent: true,
  });
  expect(fs.existsSync(path.join(root, "v0", "payload"))).toBe(true);
});

it.each(["not JSON", "", '{"id":"wrong","mounts":[]}', '{"id":"container-1"}'])(
  "rejects incomplete/malformed Podman inspection: %s",
  async (inspection) => {
    const run = jest.fn(async (_cmd, args) => ({
      stdout: args[0] === "ps" ? "container-1" : inspection,
      stderr: "",
    }));
    await expect(
      __test__.referencedToolsVersions(root, proc, run),
    ).rejects.toThrow();
  },
);

it("rejects changing container inventory rather than deleting through a start race", async () => {
  let listings = 0;
  const run = jest.fn(async (_cmd, args) => ({
    stdout: args[0] === "ps" ? (++listings === 1 ? "" : "new-container") : "",
    stderr: "",
  }));
  await expect(
    __test__.referencedToolsVersions(root, proc, run),
  ).rejects.toThrow("inventory changed");
});

it("rejects whole-tools-directory mounts whose live versions cannot be narrowed", async () => {
  await expect(
    __test__.referencedToolsVersions(root, proc, podman([{ Source: root }])),
  ).rejects.toThrow("entire tools");
});

it("does not treat denied proc access as proof that tools are unused", async () => {
  mounted("v2");
  const readFile = fs.promises.readFile.bind(fs.promises);
  jest.spyOn(fs.promises, "readFile").mockImplementation(((
    filename,
    ...args
  ) => {
    if (`${filename}` === path.join(proc, "123", "mountinfo")) {
      return Promise.reject(Object.assign(Error("denied"), { code: "EACCES" }));
    }
    return (readFile as any)(filename, ...args);
  }) as any);
  await expect(
    __test__.referencedToolsVersions(root, proc, podman([], 123)),
  ).rejects.toThrow("denied");
});

it("tolerates processes exiting during the proc scan", async () => {
  fs.mkdirSync(path.join(proc, "123"));
  await expect(
    __test__.referencedToolsVersions(root, proc, podman()),
  ).resolves.toEqual([]);
});

it("does not require root access to unrelated processes on rootless hosts", async () => {
  mounted("v2");
  fs.mkdirSync(path.join(proc, "456"));
  const readFile = fs.promises.readFile.bind(fs.promises);
  jest.spyOn(fs.promises, "readFile").mockImplementation(((
    filename,
    ...args
  ) => {
    if (`${filename}` === path.join(proc, "456", "mountinfo")) {
      return Promise.reject(
        Object.assign(Error("unrelated root process"), { code: "EACCES" }),
      );
    }
    return (readFile as any)(filename, ...args);
  }) as any);
  await expect(
    __test__.referencedToolsVersions(root, proc, podman([], 123)),
  ).resolves.toEqual(["v2"]);
});

it("skips a sweep if a listed live container disappears during inspection", async () => {
  await expect(
    __test__.referencedToolsVersions(root, proc, podman([], 123)),
  ).rejects.toThrow();
});

it("serializes cleanup with installation using the same artifact lock", async () => {
  const events: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const install = __test__.withArtifactInstallLock(root, async () => {
    events.push("install");
    await wait;
  });
  const prune = __test__.withArtifactInstallLock(root, async () => {
    events.push("prune");
  });
  await Promise.resolve();
  expect(events).toEqual(["install"]);
  release();
  await Promise.all([install, prune]);
  expect(events).toEqual(["install", "prune"]);
});

it("does not overlap maintenance sweeps or reschedule after shutdown", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const sweep = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startRuntimeArtifactMaintenance({
    sweep,
    initialDelayMs: 1,
    intervalMs: 10,
  });
  await jest.advanceTimersByTimeAsync(100);
  expect(sweep).toHaveBeenCalledTimes(1);
  stop();
  finish();
  await jest.advanceTimersByTimeAsync(100);
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("retries maintenance later after a failed sweep", async () => {
  jest.useFakeTimers();
  const sweep = jest
    .fn<Promise<void>, []>()
    .mockRejectedValueOnce(Error("scan failed"))
    .mockResolvedValue(undefined);
  const stop = startRuntimeArtifactMaintenance({
    sweep,
    initialDelayMs: 1,
    intervalMs: 10,
  });
  await jest.advanceTimersByTimeAsync(11);
  expect(sweep).toHaveBeenCalledTimes(2);
  stop();
});
