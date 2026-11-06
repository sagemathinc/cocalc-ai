// Installing a staged copy through the rootfs agent: the real agent code
// (`node -e`), behind the real client, working on a temp dir that stands for
// the container's rootfs.
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOTFS_AGENT_CODE } from "@cocalc/project-runner/run/rootfs-agent/agent-code";
import { RootfsAgentClient } from "@cocalc/project-runner/run/rootfs-agent/client";
import {
  AGENT_COPY_LIMITS,
  installThroughAgent,
  type AgentLike,
} from "./agent-copy";

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

const P = 1073741824;
const CONTAINER = {
  userns: "user:[1]",
  mntns: "mnt:[2]",
  cgroupPrefix: "/cocalc-project-pool/project-x",
};

function realAgent(): { agent: AgentLike; client: RootfsAgentClient } {
  const client = new RootfsAgentClient("x", {
    generation: async () => ({
      containerId: "c".repeat(64),
      startCounter: 1,
      uid: P,
      gid: P,
    }),
    spawn: (_gen, token) =>
      spawn(process.execPath, ["-e", ROOTFS_AGENT_CODE, "--", token], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      }) as any,
    hostFacts: async () => ({
      uid: [P, P, P, P],
      gid: [P, P, P, P],
      capEff: 0n,
      capAmb: 0n,
      noNewPrivs: 1,
      seccomp: 2,
      userns: CONTAINER.userns,
      mntns: CONTAINER.mntns,
      cgroup: `${CONTAINER.cgroupPrefix}/exec`,
    }),
    containerFacts: async () => ({ ...CONTAINER }),
    killInContainer: async () => {},
    now: () => Date.now(),
  } as any);
  return {
    client,
    agent: {
      call: async (op, args, data) => await client.request(op, args, data),
    },
  };
}

describe("installing a staged copy through the rootfs agent", () => {
  let dir: string;
  let staging: string;
  let root: string;
  let agent: AgentLike;
  let client: RootfsAgentClient;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-copy-"));
    staging = join(dir, "staging");
    root = join(dir, "rootfs");
    await mkdir(join(staging, "tree", "sub"), { recursive: true });
    await writeFile(join(staging, "tree", "a.txt"), "aaa");
    await writeFile(join(staging, "tree", "sub", "b.txt"), "bbb");
    await writeFile(join(staging, "tree", "suid"), "s");
    await chmod(join(staging, "tree", "suid"), 0o4755);
    await symlink("../a.txt", join(staging, "tree", "sub", "link"));
    await mkdir(join(root, "etc"), { recursive: true });
    ({ agent, client } = realAgent());
  });

  afterEach(async () => {
    client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("copies a tree into a missing destination: files, modes, symlinks as links", async () => {
    const dest = join(root, "etc", "new", "tree");
    expect(
      await installThroughAgent({ src: join(staging, "tree"), agent, dest }),
    ).toBe(true);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("aaa");
    expect(await readFile(join(dest, "sub", "b.txt"), "utf8")).toBe("bbb");
    expect(await readlink(join(dest, "sub", "link"))).toBe("../a.txt");
    // never setuid from a project's file
    expect((await stat(join(dest, "suid"))).mode & 0o7777).toBe(0o755);
    // no temp names left anywhere
    expect((await readdir(dest)).sort()).toEqual(["a.txt", "sub", "suid"]);
  });

  it("never asks the agent for a setuid or setgid mode (the kernel would hide it)", async () => {
    const modes: number[] = [];
    const recording: AgentLike = {
      call: async (op, args, data) => {
        if (op === "writeFile") modes.push(args.mode as number);
        return await agent.call(op, args, data);
      },
    };
    await installThroughAgent({
      src: join(staging, "tree"),
      agent: recording,
      dest: join(root, "etc", "tree"),
    });
    expect(modes.length).toBe(3);
    for (const m of modes) expect(m & 0o6000).toBe(0);
    expect(modes).toContain(0o755);
  });

  it("merges into an existing directory: force replaces, no force keeps, errorOnExist refuses the top", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(dest);
    await writeFile(join(dest, "a.txt"), "old");
    await writeFile(join(dest, "mine"), "keep");
    await installThroughAgent({
      src: join(staging, "tree"),
      agent,
      dest,
      options: { force: false },
    });
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("old");
    expect(await readFile(join(dest, "sub", "b.txt"), "utf8")).toBe("bbb");
    await installThroughAgent({ src: join(staging, "tree"), agent, dest });
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("aaa");
    expect(await readFile(join(dest, "mine"), "utf8")).toBe("keep");
    await expect(
      installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest,
        options: { force: false, errorOnExist: true },
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
  });

  it("replaces exactly for an exact copy, leaving no hidden siblings", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(dest);
    await writeFile(join(dest, "stale"), "x");
    expect(
      await installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest,
        exact: true,
      }),
    ).toBe(true);
    expect((await readdir(dest)).sort()).toEqual(["a.txt", "sub", "suid"]);
    expect(await readdir(join(root, "etc"))).toEqual(["tree"]);
    // an exact no-clobber copy finds it there: false, untouched
    await writeFile(join(dest, "a.txt"), "mine");
    expect(
      await installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest,
        exact: true,
        options: { force: false },
      }),
    ).toBe(false);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("mine");
  });

  // a real agent whose rename(s) matching `fail` throw EIO
  const failingRenames = (fail: (a: any) => boolean): AgentLike => ({
    call: async (op, args, data) => {
      if (op === "rename" && fail(args)) {
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
      return await agent.call(op, args, data);
    },
  });
  const siblings = async () =>
    (await readdir(join(root, "etc"))).filter((n) => n.startsWith(".cocalc-"));

  it("puts the old destination back when placing an exact copy fails (T1)", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(dest);
    await writeFile(join(dest, "precious"), "keep me");
    // placing the incoming copy at dest fails
    const a = failingRenames(
      (args) =>
        args.dest === dest && String(args.path).includes(".cocalc-incoming-"),
    );
    await expect(
      installThroughAgent({
        src: join(staging, "tree"),
        agent: a,
        dest,
        exact: true,
      }),
    ).rejects.toThrow("EIO: injected");
    expect(await readFile(join(dest, "precious"), "utf8")).toBe("keep me");
    expect(await siblings()).toEqual([]);
  });

  it("names where the old destination is kept when putting it back fails too (T1)", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(dest);
    await writeFile(join(dest, "precious"), "keep me");
    // placing fails, and so does every rename back to dest
    const a = failingRenames((args) => args.dest === dest);
    let message = "";
    await installThroughAgent({
      src: join(staging, "tree"),
      agent: a,
      dest,
      exact: true,
    }).catch((err) => (message = `${err.message}`));
    const left = await siblings();
    // the incoming copy is removed; only the aside remains, and the error names it
    expect(left.length).toBe(1);
    expect(left[0]).toMatch(/^\.cocalc-previous0-/);
    expect(message).toContain(left[0]);
    expect(await readFile(join(root, "etc", left[0], "precious"), "utf8")).toBe(
      "keep me",
    );
  });

  it("refuses a copy over the total entry or byte cap (T2)", async () => {
    const saved = { ...AGENT_COPY_LIMITS };
    try {
      AGENT_COPY_LIMITS.maxEntries = 3;
      await expect(
        installThroughAgent({
          src: join(staging, "tree"),
          agent,
          dest: join(root, "etc", "e"),
        }),
      ).rejects.toMatchObject({ code: "E2BIG" });
      AGENT_COPY_LIMITS.maxEntries = saved.maxEntries;
      AGENT_COPY_LIMITS.maxBytes = 4;
      await expect(
        installThroughAgent({
          src: join(staging, "tree"),
          agent,
          dest: join(root, "etc", "b"),
        }),
      ).rejects.toMatchObject({ code: "EFBIG" });
    } finally {
      Object.assign(AGENT_COPY_LIMITS, saved);
    }
  });

  it("leaves no hidden incoming tree when an exact copy stops part way (V1)", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(dest);
    await writeFile(join(dest, "precious"), "keep me");
    let n = 0;
    await expect(
      installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest,
        exact: true,
        options: {
          checkpoint: () => {
            if (++n > 3)
              throw new Error("copy did not finish before its claim expired");
          },
        },
      }),
    ).rejects.toThrow("claim expired");
    expect(await siblings()).toEqual([]);
    expect(await readFile(join(dest, "precious"), "utf8")).toBe("keep me");
  });

  it("keeps a destination symlink without force where the source has a directory (V2)", async () => {
    const dest = join(root, "etc", "tree");
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), dest);
    await installThroughAgent({
      src: join(staging, "tree"),
      agent,
      dest,
      options: { force: false },
    });
    expect((await lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(root, "elsewhere"))).toEqual([]);
  });

  it("drops setgid from a copied directory (V3)", async () => {
    await mkdir(join(staging, "sgid"));
    await chmod(join(staging, "sgid"), 0o2775);
    const dest = join(root, "etc", "sgid");
    await installThroughAgent({ src: join(staging, "sgid"), agent, dest });
    expect((await stat(dest)).mode & 0o7777).toBe(0o775);
  });

  it("keeps the times with preserveTimestamps", async () => {
    await utimes(join(staging, "tree", "a.txt"), 1000000000, 1100000000);
    const dest = join(root, "etc", "tree");
    await installThroughAgent({
      src: join(staging, "tree"),
      agent,
      dest,
      options: { preserveTimestamps: true },
    });
    const st = await lstat(join(dest, "a.txt"));
    expect(Math.floor(st.mtimeMs / 1000)).toBe(1100000000);
  });

  it("never follows a staged symlink (dereference refused)", async () => {
    await expect(
      installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest: join(root, "etc", "tree"),
        options: { dereference: true },
      }),
    ).rejects.toMatchObject({ code: "ENOTSUP" });
  });

  it("refuses a file over the agent's per-file cap, writing nothing for it", async () => {
    await truncate(join(staging, "tree", "a.txt"), 64 * 1024 * 1024 + 1);
    const dest = join(root, "etc", "big");
    const writes: string[] = [];
    const recording: AgentLike = {
      call: async (op, args, data) => {
        if (op === "writeFile") writes.push(String(args.path));
        return await agent.call(op, args, data);
      },
    };
    await expect(
      installThroughAgent({
        src: join(staging, "tree", "a.txt"),
        agent: recording,
        dest,
      }),
    ).rejects.toMatchObject({ code: "EFBIG" });
    // refused by the copier itself, before reading it or asking the agent
    expect(writes).toEqual([]);
    await expect(lstat(dest)).rejects.toThrow();
  });

  it("stops between entries once the checkpoint says so", async () => {
    let n = 0;
    await expect(
      installThroughAgent({
        src: join(staging, "tree"),
        agent,
        dest: join(root, "etc", "tree"),
        options: {
          checkpoint: () => {
            if (++n > 2)
              throw new Error("copy did not finish before its claim expired");
          },
        },
      }),
    ).rejects.toThrow("claim expired");
  });
});

describe("S2: a lying agent decides only this copy's outcome", () => {
  it("a 'done' without doing anything is just a 'done' (no other effect)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-copy-lie-"));
    try {
      await mkdir(join(dir, "tree"));
      await writeFile(join(dir, "tree", "f"), "x");
      const calls: string[] = [];
      const liar: AgentLike = {
        call: async (op) => {
          calls.push(op);
          if (op === "lstat") {
            const err = new Error("ENOENT") as any;
            err.code = "ENOENT";
            throw err;
          }
          return { result: null };
        },
      };
      expect(
        await installThroughAgent({
          src: join(dir, "tree"),
          agent: liar,
          dest: "/etc/tree",
        }),
      ).toBe(true);
      // only agent operations were asked for; the staging is the host's own
      expect(calls.every((op) => typeof op === "string")).toBe(true);
      expect(await readFile(join(dir, "tree", "f"), "utf8")).toBe("x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
