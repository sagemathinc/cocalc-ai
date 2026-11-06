// The agent's code, run for real (`node -e`) against a temp dir, spoken to
// over its framed stdin/stdout.
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  rename,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOTFS_AGENT_CODE, ROOTFS_AGENT_VERSION } from "./agent-code";
import {
  encodeChunkFrame,
  encodeJsonFrame,
  FRAME_CHUNK,
  FrameDecoder,
  type Frame,
} from "./protocol";
import { agentExecArgs } from "./spawn";

class Agent {
  readonly child: ChildProcess;
  private decoder = new FrameDecoder();
  private frames: Frame[] = [];
  private waiters: (() => void)[] = [];
  exited: Promise<number | null>;

  constructor() {
    this.child = spawn(process.execPath, ["-e", ROOTFS_AGENT_CODE, "--", "t"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    this.child.stdout!.on("data", (d: Buffer) => {
      this.frames.push(...this.decoder.push(d));
      for (const w of this.waiters.splice(0)) w();
    });
    this.exited = new Promise((resolve) => this.child.on("exit", resolve));
  }

  send(buf: Buffer) {
    this.child.stdin!.write(buf);
  }

  async next(): Promise<Frame> {
    while (this.frames.length === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.frames.shift()!;
  }

  async json(): Promise<any> {
    const f = await this.next();
    if (f.type !== 1) throw new Error("expected a JSON frame");
    return f.value;
  }

  private id = 0;
  async call(op: string, args: object = {}): Promise<any> {
    const id = ++this.id;
    this.send(encodeJsonFrame({ id, op, ...args }));
    const reply = await this.json();
    expect(reply.id).toBe(id);
    return reply;
  }

  async write(path: string, data: Buffer, chunkSize = 3, extra: object = {}) {
    const id = ++this.id;
    this.send(
      encodeJsonFrame({
        id,
        op: "writeFile",
        path,
        size: data.length,
        ...extra,
      }),
    );
    for (let i = 0; i < data.length; i += chunkSize) {
      this.send(encodeChunkFrame(id, data.subarray(i, i + chunkSize)));
    }
    return await this.json();
  }

  async read(path: string): Promise<{ reply: any; data?: Buffer }> {
    const reply = await this.call("readFile", { path });
    if (!reply.ok) return { reply };
    const parts: Buffer[] = [];
    let got = 0;
    while (got < reply.result.size) {
      const f = await this.next();
      if (f.type !== FRAME_CHUNK || f.id !== reply.id) {
        throw new Error("expected this read's chunk");
      }
      parts.push(f.data);
      got += f.data.length;
    }
    return { reply, data: Buffer.concat(parts) };
  }

  close() {
    this.child.stdin!.end();
  }
}

describe("rootfs agent code", () => {
  let dir: string;
  let agent: Agent;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rootfs-agent-"));
    agent = new Agent();
  });

  afterEach(async () => {
    agent.child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  it("says hello, with its version and pid", async () => {
    expect(await agent.json()).toEqual({
      type: "hello",
      version: ROOTFS_AGENT_VERSION,
      pid: agent.child.pid,
    });
  });

  it("does the file operations", async () => {
    await agent.json();
    expect(
      (await agent.call("mkdir", { path: `${dir}/a/b`, recursive: true })).ok,
    ).toBe(true);
    expect(
      (await agent.write(`${dir}/a/b/f.txt`, Buffer.from("hello world"))).ok,
    ).toBe(true);
    expect(await readFile(`${dir}/a/b/f.txt`, "utf8")).toBe("hello world");
    const { data } = await agent.read(`${dir}/a/b/f.txt`);
    expect(data!.toString()).toBe("hello world");
    const st = await agent.call("stat", { path: `${dir}/a/b/f.txt` });
    expect(st.result).toMatchObject({ type: "file", size: 11 });
    expect(
      (await agent.call("readdir", { path: `${dir}/a/b` })).result,
    ).toEqual({
      entries: [{ name: "f.txt", type: "file" }],
      truncated: false,
    });
    await agent.call("rename", {
      path: `${dir}/a/b/f.txt`,
      dest: `${dir}/a/g.txt`,
    });
    await agent.call("chmod", { path: `${dir}/a/g.txt`, mode: 0o600 });
    expect((await lstat(`${dir}/a/g.txt`)).mode & 0o777).toBe(0o600);
    expect(
      (await agent.call("rm", { path: `${dir}/a`, recursive: true })).ok,
    ).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    // an empty file
    expect((await agent.write(`${dir}/empty`, Buffer.alloc(0))).ok).toBe(true);
    expect(await readFile(`${dir}/empty`, "utf8")).toBe("");
  });

  it("reports errors by code, and refuses paths that aren't absolute and normal", async () => {
    await agent.json();
    expect((await agent.call("stat", { path: `${dir}/nope` })).error.code).toBe(
      "ENOENT",
    );
    for (const path of [
      "relative",
      `${dir}/../x`,
      `${dir}/./x`,
      `${dir}//x`,
      `${dir}/x/`,
      `${dir}/\0x`,
      `/${"a".repeat(256)}`,
      `/${"a/".repeat(2100)}a`,
      42,
    ]) {
      const reply = await agent.call("stat", { path });
      expect(reply.ok).toBe(false);
      expect(["EINVAL", "ENAMETOOLONG"]).toContain(reply.error.code);
    }
    expect(
      (await agent.call("rm", { path: "/", recursive: true })).error.code,
    ).toBe("EPERM");
    expect((await agent.call("nope")).error.code).toBe("ENOSYS");
  });

  it("refuses a file over the size cap, without reading it", async () => {
    await agent.json();
    await writeFile(`${dir}/big`, "");
    await truncate(`${dir}/big`, 64 * 1024 * 1024 + 1);
    const { reply } = await agent.read(`${dir}/big`);
    expect(reply.error.code).toBe("EFBIG");
  });

  it("removes a tree without following symlinks out of it", async () => {
    await agent.json();
    await mkdir(`${dir}/keep`);
    await writeFile(`${dir}/keep/precious`, "x");
    await mkdir(`${dir}/tree`);
    await symlink(`${dir}/keep`, `${dir}/tree/link`);
    expect(
      (await agent.call("rm", { path: `${dir}/tree`, recursive: true })).ok,
    ).toBe(true);
    expect(await readFile(`${dir}/keep/precious`, "utf8")).toBe("x");
  });

  it("writes through a temp file: no partial file when cut off", async () => {
    await agent.json();
    await writeFile(`${dir}/f`, "old");
    // a write cut off by the end of stdin leaves the old file and no temp
    const id = 77;
    agent.send(
      encodeJsonFrame({ id, op: "writeFile", path: `${dir}/f`, size: 10 }),
    );
    agent.send(encodeChunkFrame(id, Buffer.from("new")));
    // the temp file exists before stdin ends
    while (!(await readdir(dir)).some((n) => n.startsWith(".cocalc-write-"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    agent.close();
    expect(await agent.exited).toBe(0);
    expect(await readFile(`${dir}/f`, "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["f"]);
  });

  it("never writes through a symlink planted at its temp name", async () => {
    const { pid } = await agent.json();
    await writeFile(`${dir}/outside`, "untouched");
    // the temp name for request id 1 writing f
    await symlink(`${dir}/outside`, `${dir}/.cocalc-write-${pid}-1-f`);
    const reply = await agent.write(`${dir}/f`, Buffer.from("data"));
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("EEXIST");
    expect(await readFile(`${dir}/outside`, "utf8")).toBe("untouched");
    await expect(lstat(`${dir}/f`)).rejects.toThrow();
  });

  it("refuses to install through a symlinked directory on the way", async () => {
    await agent.json();
    await mkdir(`${dir}/outside`);
    await mkdir(`${dir}/a`);
    await symlink(`${dir}/outside`, `${dir}/a/link`);
    const reply = await agent.write(`${dir}/a/link/f`, Buffer.from("data"));
    expect(reply.ok).toBe(false);
    expect(["ELOOP", "ENOTDIR"]).toContain(reply.error.code);
    expect(await readdir(`${dir}/outside`)).toEqual([]);
  });

  it("installs into the directory it verified, even if the path is swapped for a symlink meanwhile", async () => {
    await agent.json();
    await mkdir(`${dir}/outside`);
    await mkdir(`${dir}/a/b`, { recursive: true });
    const id = 41;
    agent.send(
      encodeJsonFrame({ id, op: "writeFile", path: `${dir}/a/b/f`, size: 6 }),
    );
    agent.send(encodeChunkFrame(id, Buffer.from("abc")));
    // let the agent open the destination, then swap the directory
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rename(`${dir}/a/b`, `${dir}/a/b-real`);
    await symlink(`${dir}/outside`, `${dir}/a/b`);
    agent.send(encodeChunkFrame(id, Buffer.from("def")));
    const reply = await agent.json();
    expect(reply).toMatchObject({ id, ok: true });
    expect(await readdir(`${dir}/outside`)).toEqual([]);
    expect(await readFile(`${dir}/a/b-real/f`, "utf8")).toBe("abcdef");
  });

  it("installs without replacing when asked (noReplace), leaving no temp", async () => {
    await agent.json();
    await writeFile(`${dir}/f`, "old");
    const r1 = await agent.write(`${dir}/f`, Buffer.from("new"), 3, {
      noReplace: true,
    });
    expect(r1.error.code).toBe("EEXIST");
    expect(await readFile(`${dir}/f`, "utf8")).toBe("old");
    const r2 = await agent.write(`${dir}/g`, Buffer.from("new"), 3, {
      noReplace: true,
    });
    expect(r2.ok).toBe(true);
    expect(await readFile(`${dir}/g`, "utf8")).toBe("new");
    expect((await readdir(dir)).sort()).toEqual(["f", "g"]);
    // without noReplace, the same write replaces
    expect((await agent.write(`${dir}/f`, Buffer.from("new"))).ok).toBe(true);
    expect(await readFile(`${dir}/f`, "utf8")).toBe("new");
  });

  it("sets the times it was given on the installed file", async () => {
    await agent.json();
    const reply = await agent.write(`${dir}/t`, Buffer.from("x"), 3, {
      atime: 1000000000,
      mtime: 1100000000,
    });
    expect(reply.ok).toBe(true);
    const st = await lstat(`${dir}/t`);
    expect(Math.floor(st.mtimeMs / 1000)).toBe(1100000000);
    expect(Math.floor(st.atimeMs / 1000)).toBe(1000000000);
    // bad times are refused, nothing installed
    const bad = await agent.write(`${dir}/u`, Buffer.from("x"), 3, {
      atime: -1,
      mtime: 5,
    });
    expect(bad.error.code).toBe("EINVAL");
    await expect(lstat(`${dir}/u`)).rejects.toThrow();
  });

  it("makes symlinks exactly at the path, never through one on the way", async () => {
    await agent.json();
    expect(
      (
        await agent.call("symlink", {
          path: `${dir}/l`,
          target: "../somewhere",
        })
      ).ok,
    ).toBe(true);
    const { readlink } = await import("node:fs/promises");
    expect(await readlink(`${dir}/l`)).toBe("../somewhere");
    // noReplace on something there: EEXIST, untouched
    await writeFile(`${dir}/f`, "keep");
    expect(
      (
        await agent.call("symlink", {
          path: `${dir}/f`,
          target: "x",
          noReplace: true,
        })
      ).error.code,
    ).toBe("EEXIST");
    expect(await readFile(`${dir}/f`, "utf8")).toBe("keep");
    // without it, a file is replaced by the link, and no temp is left
    expect(
      (await agent.call("symlink", { path: `${dir}/f`, target: "y" })).ok,
    ).toBe(true);
    expect(await readlink(`${dir}/f`)).toBe("y");
    expect((await readdir(dir)).sort()).toEqual(["f", "l"]);
    // never through a symlinked directory
    await mkdir(`${dir}/outside`);
    await symlink(`${dir}/outside`, `${dir}/via`);
    const r = await agent.call("symlink", {
      path: `${dir}/via/l`,
      target: "z",
    });
    expect(["ELOOP", "ENOTDIR"]).toContain(r.error.code);
    expect(await readdir(`${dir}/outside`)).toEqual([]);
    // bad targets
    for (const target of ["", "a\0b", 5]) {
      expect(
        (await agent.call("symlink", { path: `${dir}/b`, target })).error.code,
      ).toBe("EINVAL");
    }
  });

  it("installs the exact mode it was given, whatever the umask (T3)", async () => {
    await agent.json();
    for (const [name, mode] of [
      ["a", 0o666],
      ["b", 0o777],
      ["c", 0o660],
      ["d", 0o600],
    ] as const) {
      const r = await agent.write(`${dir}/${name}`, Buffer.from("x"), 3, {
        mode,
      });
      expect(r.ok).toBe(true);
      expect((await lstat(`${dir}/${name}`)).mode & 0o7777).toBe(mode);
    }
  });

  it("never makes a noReplace symlink through a symlinked directory (V4)", async () => {
    await agent.json();
    await mkdir(`${dir}/outside`);
    await symlink(`${dir}/outside`, `${dir}/via`);
    const r = await agent.call("symlink", {
      path: `${dir}/via/l`,
      target: "z",
      noReplace: true,
    });
    expect(["ELOOP", "ENOTDIR"]).toContain(r.error.code);
    expect(await readdir(`${dir}/outside`)).toEqual([]);
  });

  it("dies on a protocol error, cleaning up its writes", async () => {
    await agent.json();
    agent.send(
      encodeJsonFrame({ id: 5, op: "writeFile", path: `${dir}/f`, size: 3 }),
    );
    agent.send(encodeChunkFrame(5, Buffer.from("toolong")));
    expect(await agent.exited).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("dies on an unknown frame type or a chunk for nothing", async () => {
    await agent.json();
    agent.send(encodeChunkFrame(9, Buffer.from("x")));
    expect(await agent.exited).toBe(2);
  });

  it("exits when its stdin ends", async () => {
    await agent.json();
    agent.close();
    expect(await agent.exited).toBe(0);
  });
});

describe("rootfs agent code, statically", () => {
  it("requires only node: builtins (E1)", () => {
    const requires = ROOTFS_AGENT_CODE.match(/require\([^)]*\)/g) ?? [];
    expect(requires.length).toBeGreaterThan(0);
    for (const r of requires) expect(r).toMatch(/^require\("node:[a-z_/]+"\)$/);
    expect(ROOTFS_AGENT_CODE).not.toMatch(/\bimport\s*\(/);
  });

  it("stays well under the argument size limit (E3)", () => {
    expect(Buffer.byteLength(ROOTFS_AGENT_CODE)).toBeLessThan(32 * 1024);
  });

  it("makes every symlink and every installed file only relative to a verified directory fd (V4)", () => {
    // a call with a path string would follow a directory swapped after
    // openParent returned; only at(fd, name) names are anchored
    const calls =
      ROOTFS_AGENT_CODE.match(/fsp\.(symlink|link|rename)\([^;]*\)/g) ?? [];
    const anchored = (call: string) =>
      call.startsWith("fsp.rename(checkPath")
        ? true // the plain rename op: the user's own request, by path
        : /\bat\(/.test(call.split(",").slice(1).join(","));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls.filter((c) => c.startsWith("fsp.symlink"))) {
      expect(call).toMatch(/,\s*at\(/);
    }
    for (const call of calls) expect(anchored(call)).toBe(true);
  });

  it("is one static string: the same for every project, with no per-call data (E4)", () => {
    const base = {
      nodePath: "/opt/cocalc/bin/node",
      agentCode: ROOTFS_AGENT_CODE,
      toolsPath: "/opt/cocalc/bin2",
    };
    const a = agentExecArgs({
      ...base,
      containerId: "a".repeat(64),
      token: "0".repeat(32),
    });
    const b = agentExecArgs({
      ...base,
      containerId: "b".repeat(64),
      token: "1".repeat(32),
    });
    expect(a[a.indexOf("-e") + 1]).toBe(b[b.indexOf("-e") + 1]);
    expect(a[a.indexOf("-e") + 1]).toBe(ROOTFS_AGENT_CODE);
  });
});
