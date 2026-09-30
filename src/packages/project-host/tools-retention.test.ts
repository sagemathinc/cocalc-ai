import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { upsertProject } from "./sqlite/projects";
import { __test__, startRuntimeArtifactMaintenance } from "./upgrade";

let base: string;
let root: string;
let proc: string;
const oldData = process.env.COCALC_DATA;
const oldDatabase = process.env.COCALC_LITE_SQLITE_FILENAME;
const oldRuntime = process.env.COCALC_PODMAN_RUNTIME_DIR;
const oldBootstrap = process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR;
const oldTools = process.env.COCALC_PROJECT_TOOLS;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tools-retention-"));
  root = path.join(base, "tools");
  proc = path.join(base, "proc");
  fs.mkdirSync(root);
  fs.mkdirSync(proc);
  process.env.COCALC_DATA = path.join(base, "data");
  process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
  process.env.COCALC_PODMAN_RUNTIME_DIR = base;
  process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = base;
  delete process.env.COCALC_PROJECT_TOOLS;
  fs.writeFileSync(
    path.join(base, "bootstrap-desired-state.json"),
    JSON.stringify({
      tools_bundle: { root, version: "v6", retention_lock_protocol: 1 },
    }),
  );
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
  if (oldBootstrap === undefined)
    delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR;
  else process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = oldBootstrap;
  if (oldTools === undefined) delete process.env.COCALC_PROJECT_TOOLS;
  else process.env.COCALC_PROJECT_TOOLS = oldTools;
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
  expect(refs).toBeNull();
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

it("does not inventory directories after failed discovery, even if inventory is unreadable", async () => {
  versions();
  const refs = await __test__.protectedArtifactVersions(
    { artifact: "tools", desiredVersion: "v6", root },
    async () => {
      throw Error("scan failed");
    },
  );
  const readdir = jest
    .spyOn(fs.promises, "readdir")
    .mockRejectedValue(Error("unreadable"));
  await __test__.pruneVersionDirs({
    root,
    currentLink: path.join(root, "current"),
    desiredDir: path.join(root, "v6"),
    protectedVersions: refs,
    keep: 1,
  });
  expect(readdir).not.toHaveBeenCalled();
});

it("does not prune versions appearing after a failed reference scan", async () => {
  versions();
  const refs = await __test__.protectedArtifactVersions(
    { artifact: "tools", desiredVersion: "v6", root },
    async () => {
      throw Error("scan failed");
    },
  );
  fs.mkdirSync(path.join(root, "v-new"));
  await __test__.pruneVersionDirs({
    root,
    currentLink: path.join(root, "current"),
    desiredDir: path.join(root, "v6"),
    protectedVersions: refs,
    keep: 1,
  });
  expect(fs.existsSync(path.join(root, "v-new"))).toBe(true);
});

it.each(["explicit", "bootstrap"])(
  "protects the not-yet-mounted %s tools version",
  async (source) => {
    versions();
    if (source === "explicit")
      process.env.COCALC_PROJECT_TOOLS = path.join(root, "v0");
    else
      fs.writeFileSync(
        path.join(base, "bootstrap-desired-state.json"),
        JSON.stringify({
          tools_bundle: { root, version: "v0", retention_lock_protocol: 1 },
        }),
      );
    const refs = await __test__.protectedArtifactVersions(
      { artifact: "tools", desiredVersion: "v6", root },
      async () => [],
    );
    expect(refs).toContain("v0");
    await __test__.pruneVersionDirs({
      root,
      currentLink: path.join(root, "current"),
      desiredDir: path.join(root, "v6"),
      protectedVersions: refs,
      keep: 1,
    });
    expect(fs.existsSync(path.join(root, "v0", "payload"))).toBe(true);
    expect(fs.existsSync(path.join(root, "v2"))).toBe(false);
  },
);

it.each(["missing", "old", "malformed"])(
  "skips pruning with %s bootstrap coordination state",
  async (state) => {
    const filename = path.join(base, "bootstrap-desired-state.json");
    if (state === "missing") fs.unlinkSync(filename);
    else
      fs.writeFileSync(
        filename,
        state === "old" ? '{"tools_bundle":{"version":"v0"}}' : "{",
      );
    expect(
      await __test__.protectedArtifactVersions(
        { artifact: "tools", desiredVersion: "v6", root },
        async () => [],
      ),
    ).toBeNull();
  },
);

it("keeps an OS lock across awaits and releases it after failure", async () => {
  const probe = () =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn("flock", [
        "-n",
        path.join(root, ".artifact.lock"),
        "true",
      ]);
      child.once("error", reject);
      child.once("exit", resolve);
    });
  await expect(
    __test__.withToolsFilesystemLock(root, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await probe()).toBe(1);
      throw Error("work failed");
    }),
  ).rejects.toThrow("work failed");
  expect(await probe()).toBe(0);
});

it("serializes with Python bootstrap activation in a separate process", async () => {
  versions();
  const lock = path.join(root, ".artifact.lock");
  const script = `import os, sys\nfrom types import SimpleNamespace\nsys.path.insert(0, sys.argv[4])\nimport bootstrap\nroot = os.path.dirname(sys.argv[1])\nbundle = SimpleNamespace(root=root)\ncfg = SimpleNamespace(tools_bundle=bundle)\ndef activate(cfg, bundle):\n print('locked', flush=True)\n sys.stdin.readline()\n os.unlink(sys.argv[2])\n os.symlink(sys.argv[3], sys.argv[2])\n return bundle\nbootstrap.extract_bundle_unlocked = activate\nbootstrap.extract_bundle(cfg, bundle)\n`;
  const child = spawn("python3", [
    "-c",
    script,
    lock,
    path.join(root, "current"),
    path.join(root, "v0"),
    path.resolve(__dirname, "../server/cloud/bootstrap"),
  ]);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await new Promise<void>((resolve) =>
    child.stdout.once("data", () => resolve()),
  );
  let entered = false;
  const cleanup = __test__.withToolsFilesystemLock(root, async () => {
    entered = true;
    await __test__.pruneVersionDirs({
      root,
      currentLink: path.join(root, "current"),
      desiredDir: path.join(root, "v6"),
      keep: 1,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const enteredBeforeRelease = entered;
  child.stdin.end("activate\n");
  await exited;
  await cleanup;
  expect(enteredBeforeRelease).toBe(false);
  expect(fs.realpathSync(path.join(root, "current"))).toBe(
    path.join(root, "v0"),
  );
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
