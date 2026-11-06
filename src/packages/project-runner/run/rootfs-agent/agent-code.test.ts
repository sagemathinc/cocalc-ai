// The agent's code, run for real (`node -e`) against a temp dir, spoken to
// over its framed stdin/stdout.
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
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

  async write(path: string, data: Buffer, chunkSize = 3) {
    const id = ++this.id;
    this.send(
      encodeJsonFrame({ id, op: "writeFile", path, size: data.length }),
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
