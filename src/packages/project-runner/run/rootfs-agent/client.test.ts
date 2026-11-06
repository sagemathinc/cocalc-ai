import { EventEmitter } from "node:events";

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

import {
  AgentUnavailableError,
  checkAgentAuthority,
  checkResult,
  hostBufferedBytes,
  LIMITS,
  RootfsAgentClient,
  type AgentDeps,
  type AgentGeneration,
  type AgentHostFacts,
  type ContainerFacts,
} from "./client";
import {
  encodeChunkFrame,
  encodeJsonFrame,
  FrameDecoder,
  ProtocolError,
} from "./protocol";

const P = 1073741824;
const GEN: AgentGeneration = {
  containerId: "c".repeat(64),
  startCounter: 1,
  uid: P,
  gid: P,
};
const CONTAINER: ContainerFacts = {
  userns: "user:[4026532001]",
  mntns: "mnt:[4026532002]",
  cgroupPrefix: "/cocalc-project-pool/project-x",
};
const FACTS: AgentHostFacts = {
  uid: [P, P, P, P],
  gid: [P, P, P, P],
  capEff: 0n,
  capAmb: 0n,
  noNewPrivs: 1,
  seccomp: 2,
  userns: CONTAINER.userns,
  mntns: CONTAINER.mntns,
  cgroup: `${CONTAINER.cgroupPrefix}/exec`,
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  received: any[] = [];
  chunks: { id: number; data: Buffer }[] = [];
  killed = false;
  private decoder = new FrameDecoder();
  stdin = {
    write: (data: Buffer) => {
      for (const f of this.decoder.push(data)) {
        if (f.type === 1) this.received.push(f.value);
        else this.chunks.push({ id: f.id, data: f.data });
      }
      return true;
    },
    end: () => {},
  };
  kill() {
    this.killed = true;
  }
  say(value: unknown) {
    this.stdout.emit("data", encodeJsonFrame(value));
  }
  raw(data: Buffer) {
    this.stdout.emit("data", data);
  }
}

function setup(over: Partial<AgentDeps> = {}) {
  const children: FakeChild[] = [];
  const state = { gen: { ...GEN } as AgentGeneration | undefined, t: 0 };
  const killInContainer = jest.fn(() => new Promise<void>(() => {}));
  const deps: AgentDeps = {
    generation: async () => (state.gen ? { ...state.gen } : undefined),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      setImmediate(() => child.say({ type: "hello", version: 1, pid: 7 }));
      return child;
    },
    hostFacts: async () => ({ ...FACTS }),
    containerFacts: async () => ({ ...CONTAINER }),
    killInContainer,
    now: () => state.t,
    ...over,
  };
  const client = new RootfsAgentClient("x", deps);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const child = async () => {
    while (children.length === 0) await tick();
    return children[children.length - 1];
  };
  // answer the n-th request the child receives
  const answer = async (reply: (req: any) => unknown, n = 0) => {
    const c = await child();
    while (c.received.length <= n) await tick();
    c.say(reply(c.received[n]));
  };
  return { client, state, children, child, answer, killInContainer, tick };
}

describe("checkAgentAuthority", () => {
  it("passes exactly the project user's authority", () => {
    expect(checkAgentAuthority(FACTS, GEN, CONTAINER)).toEqual([]);
  });

  const cases: [
    string,
    Partial<AgentHostFacts> | ((c: ContainerFacts) => ContainerFacts),
  ][] = [
    ["a saved uid of 0 (setuid root)", { uid: [P, P, 0, P] }],
    ["the runtime user", { uid: [2000, 2000, 2000, 2000] }],
    ["another gid", { gid: [P, P, P, 0] }],
    ["an effective capability", { capEff: 1n << 21n }],
    ["an ambient capability", { capAmb: 1n }],
    ["no no_new_privs", { noNewPrivs: 0 }],
    ["no seccomp", { seccomp: 0 }],
    ["the host's user namespace", { userns: "user:[4026531837]" }],
    ["the host's mount namespace", { mntns: "mnt:[4026531841]" }],
    ["another cgroup", { cgroup: "/system.slice/cocalc-project-host.service" }],
    ["a sibling cgroup prefix", { cgroup: `${CONTAINER.cgroupPrefix}-other` }],
    ["truncated uids", { uid: [P, P] }],
  ];
  for (const [name, change] of cases) {
    it(`refuses ${name}`, () => {
      expect(
        checkAgentAuthority(
          { ...FACTS, ...(change as object) },
          GEN,
          CONTAINER,
        ),
      ).not.toEqual([]);
    });
  }

  it.each(["userns", "mntns"] as const)(
    "refuses an empty container %s, even when the agent's is empty too",
    (key) => {
      expect(
        checkAgentAuthority({ ...FACTS, [key]: "" }, GEN, {
          ...CONTAINER,
          [key]: "",
        }),
      ).not.toEqual([]);
    },
  );

  it("refuses an empty cgroup prefix, even with the agent at the root", () => {
    expect(
      checkAgentAuthority({ ...FACTS, cgroup: "" }, GEN, {
        ...CONTAINER,
        cgroupPrefix: "",
      }),
    ).not.toEqual([]);
  });

  it("refuses when the container's facts are missing", () => {
    expect(
      checkAgentAuthority(FACTS, GEN, {
        userns: "",
        mntns: "",
        cgroupPrefix: "",
      }),
    ).toHaveLength(3);
  });
});

describe("checkResult", () => {
  it("keeps only the schema's fields", () => {
    expect(
      checkResult("stat", {
        type: "file",
        mode: 0o100644,
        uid: 2001,
        gid: 2001,
        size: 3,
        nlink: 1,
        ino: 5,
        mtimeMs: 1,
        atimeMs: 1,
        ctimeMs: 1,
        extra: "x",
      }),
    ).not.toHaveProperty("extra");
  });

  it.each([
    ["stat", { type: "weird" }],
    ["stat", null],
    [
      "readdir",
      { entries: [{ name: "../x", type: "file" }], truncated: false },
    ],
    ["readdir", { entries: [{ name: "a/b", type: "file" }], truncated: false }],
    ["readdir", { entries: [{ name: "", type: "file" }], truncated: false }],
    ["readdir", { entries: [], truncated: "no" }],
    ["readlink", "a\0b"],
    ["readlink", 42],
    ["readFile", { size: 64 * 1024 * 1024 + 1 }],
    ["readFile", { size: -1 }],
    ["mkdir", { done: true }],
    ["nope", null],
  ])("refuses a malformed %s result", (op, result) => {
    expect(() => checkResult(op, result)).toThrow(ProtocolError);
  });
});

describe("RootfsAgentClient", () => {
  const saved = { ...LIMITS };
  afterEach(() => Object.assign(LIMITS, saved));

  it("runs a request after checking the agent's authority", async () => {
    const t = setup();
    const done = t.client.request("stat", { path: "/etc/os-release" });
    await t.answer((req) => ({
      id: req.id,
      ok: true,
      result: {
        type: "file",
        mode: 0o100644,
        uid: 0,
        gid: 0,
        size: 10,
        nlink: 1,
        ino: 1,
        mtimeMs: 0,
        atimeMs: 0,
        ctimeMs: 0,
      },
    }));
    expect((await done).result).toMatchObject({ type: "file", size: 10 });
    expect((await t.child()).received[0]).toMatchObject({
      op: "stat",
      path: "/etc/os-release",
    });
  });

  it("assembles a read from its chunks, and sends a write's data as chunks", async () => {
    const t = setup();
    const read = t.client.request("readFile", { path: "/etc/x" });
    const c = await t.child();
    await t.answer((req) => ({ id: req.id, ok: true, result: { size: 6 } }));
    const id = c.received[0].id;
    c.raw(encodeChunkFrame(id, Buffer.from("abc")));
    c.raw(encodeChunkFrame(id, Buffer.from("def")));
    expect((await read).data!.toString()).toBe("abcdef");

    const write = t.client.request(
      "writeFile",
      { path: "/etc/y" },
      Buffer.from("hello"),
    );
    await t.answer((req) => ({ id: req.id, ok: true, result: null }), 1);
    await write;
    expect(c.received[1]).toMatchObject({ op: "writeFile", size: 5 });
    expect(Buffer.concat(c.chunks.map((x) => x.data)).toString()).toBe("hello");
  });

  it("passes an error code through, and only a code", async () => {
    const t = setup();
    const done = t.client.request("stat", { path: "/nope" });
    await t.answer((req) => ({
      id: req.id,
      ok: false,
      error: { code: "ENOENT", message: "/host/secret leaked in a message" },
    }));
    await expect(done).rejects.toMatchObject({ code: "ENOENT" });
    await expect(done).rejects.not.toThrow("/host/secret");
  });

  it("refuses a write over the per-file cap before any spawn or request (B2)", async () => {
    const t = setup();
    await expect(
      t.client.request(
        "writeFile",
        { path: "/etc/big" },
        Buffer.alloc(LIMITS.maxFileBytes + 1),
      ),
    ).rejects.toMatchObject({ code: "EFBIG" });
    expect(t.children).toHaveLength(0);
    expect(t.client.inFlight()).toEqual({ bufferedBytes: 0, pending: 0 });
  });

  it("rejects promptly, leaking nothing, when the agent exits during its authority check (B3)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      hostFacts: async () => {
        await gate;
        return { ...FACTS };
      },
    });
    const done = t.client.request("stat", { path: "/x" });
    const c = await t.child();
    // hello has been sent; it exits while the host reads its facts
    while (c.listenerCount("exit") === 0) await t.tick();
    await t.tick();
    c.emit("exit", 0);
    release();
    let hung: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      done.then(
        () => "resolved",
        (err) => `rejected:${err.name}`,
      ),
      new Promise((r) => {
        hung = setTimeout(() => r("hung"), 2000);
      }),
    ]);
    clearTimeout(hung);
    expect(outcome).toBe("rejected:AgentUnavailableError");
    // refused by the start itself, which saw its child go
    await expect(done).rejects.toThrow("went away while it started");
    expect(t.client.inFlight()).toEqual({ bufferedBytes: 0, pending: 0 });
    expect(c.received).toEqual([]);
  });

  it("bounds buffered bytes per project, releasing on success, error and dispose (B4)", async () => {
    LIMITS.maxProjectBufferedBytes = 10;
    const t = setup();
    const w1 = t.client.request("writeFile", { path: "/a" }, Buffer.alloc(8));
    const c = await t.child();
    while (c.received.length < 1) await t.tick();
    expect(t.client.inFlight().bufferedBytes).toBe(8);
    // the next one doesn't fit: refused, the first undisturbed
    await expect(
      t.client.request("writeFile", { path: "/b" }, Buffer.alloc(8)),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    c.say({ id: c.received[0].id, ok: true, result: null });
    await w1;
    expect(t.client.inFlight().bufferedBytes).toBe(0);
    // released on an error reply
    const w2 = t.client.request("writeFile", { path: "/c" }, Buffer.alloc(8));
    while (c.received.length < 2) await t.tick();
    c.say({
      id: c.received[1].id,
      ok: false,
      error: { code: "EACCES", message: "x" },
    });
    await expect(w2).rejects.toMatchObject({ code: "EACCES" });
    expect(t.client.inFlight().bufferedBytes).toBe(0);
    // released on dispose
    const w3 = t.client.request("writeFile", { path: "/d" }, Buffer.alloc(8));
    while (c.received.length < 3) await t.tick();
    expect(t.client.inFlight().bufferedBytes).toBe(8);
    c.emit("exit", 0);
    await expect(w3).rejects.toMatchObject({ name: "AgentUnavailableError" });
    expect(t.client.inFlight()).toEqual({ bufferedBytes: 0, pending: 0 });
  });

  it("refuses a read whose announced size doesn't fit, dropping its chunks, without disposing (B4)", async () => {
    LIMITS.maxProjectBufferedBytes = 4;
    const t = setup();
    const read = t.client.request("readFile", { path: "/etc/x" });
    const c = await t.child();
    await t.answer((req) => ({ id: req.id, ok: true, result: { size: 6 } }));
    const id = c.received[0].id;
    c.raw(encodeChunkFrame(id, Buffer.from("abc")));
    c.raw(encodeChunkFrame(id, Buffer.from("def")));
    await expect(read).rejects.toMatchObject({ code: "EAGAIN" });
    expect(t.client.inFlight()).toEqual({ bufferedBytes: 0, pending: 0 });
    // the agent is still in use
    expect(c.killed).toBe(false);
    const st = t.client.request("stat", { path: "/y" });
    await t.answer(
      (req) => ({
        id: req.id,
        ok: true,
        result: {
          type: "file",
          mode: 0,
          uid: 0,
          gid: 0,
          size: 0,
          nlink: 1,
          ino: 1,
          mtimeMs: 0,
          atimeMs: 0,
          ctimeMs: 0,
        },
      }),
      1,
    );
    await st;
  });

  it("bounds buffered bytes host-wide, across projects, with a share per project (B4)", async () => {
    LIMITS.maxProjectBufferedBytes = 8;
    LIMITS.maxHostBufferedBytes = 12;
    const a = setup();
    const b = setup();
    const wa = a.client.request("writeFile", { path: "/a" }, Buffer.alloc(8));
    const ca = await a.child();
    while (ca.received.length < 1) await a.tick();
    // a is at its share: refused, while b still gets its own
    await expect(
      a.client.request("writeFile", { path: "/a2" }, Buffer.alloc(1)),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    const wb = b.client.request("writeFile", { path: "/b" }, Buffer.alloc(4));
    const cb = await b.child();
    while (cb.received.length < 1) await b.tick();
    expect(hostBufferedBytes()).toBe(12);
    // the host is full: b's next is refused even under its own share
    await expect(
      b.client.request("writeFile", { path: "/b2" }, Buffer.alloc(1)),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    ca.say({ id: ca.received[0].id, ok: true, result: null });
    cb.say({ id: cb.received[0].id, ok: true, result: null });
    await wa;
    await wb;
    expect(hostBufferedBytes()).toBe(0);
  });

  it("refuses rootfs operations when the agent's authority is wrong, never falling back", async () => {
    const t = setup({
      hostFacts: async () => ({ ...FACTS, uid: [P, P, 0, P] }),
    });
    await expect(
      t.client.request("stat", { path: "/x" }),
    ).rejects.toMatchObject({
      name: "AgentUnavailableError",
      retryable: false,
    });
    const c = await t.child();
    expect(c.killed).toBe(true);
    expect(c.received).toEqual([]);
    expect(t.killInContainer).toHaveBeenCalled();
  });

  it("refuses when the project isn't running separate", async () => {
    const t = setup();
    t.state.gen = undefined;
    await expect(
      t.client.request("stat", { path: "/x" }),
    ).rejects.toMatchObject({
      retryable: false,
    });
    expect(t.children).toHaveLength(0);
  });

  it("never sends a request to a new container through an old client (R1)", async () => {
    const t = setup();
    const first = t.client.request("stat", { path: "/x" });
    await t.answer((req) => ({
      id: req.id,
      ok: false,
      error: { code: "ENOENT" },
    }));
    await expect(first).rejects.toMatchObject({ code: "ENOENT" });
    const c = await t.child();
    // the project restarted: same name, new container
    t.state.gen = { ...GEN, containerId: "d".repeat(64), startCounter: 2 };
    await expect(
      t.client.request("stat", { path: "/y" }),
    ).rejects.toMatchObject({
      name: "AgentUnavailableError",
      retryable: true,
    });
    expect(c.received).toHaveLength(1);
    expect(c.killed).toBe(true);
  });

  it("refuses an agent whose container changed while it started", async () => {
    let calls = 0;
    const t = setup({
      generation: async () =>
        ++calls < 2 ? { ...GEN } : { ...GEN, startCounter: 9 },
    });
    await expect(
      t.client.request("stat", { path: "/x" }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect((await t.child()).killed).toBe(true);
  });

  const violations: [string, (c: FakeChild, req: any) => void][] = [
    ["an unsolicited reply", (c) => c.say({ id: 999, ok: true, result: null })],
    [
      "a duplicate reply",
      (c, req) => {
        c.say({ id: req.id, ok: false, error: { code: "ENOENT" } });
        c.say({ id: req.id, ok: false, error: { code: "ENOENT" } });
      },
    ],
    [
      "a malformed result",
      (c, req) => c.say({ id: req.id, ok: true, result: { type: 1 } }),
    ],
    [
      "a malformed error",
      (c, req) => c.say({ id: req.id, ok: false, error: { code: "../x" } }),
    ],
    ["neither ok nor error", (c, req) => c.say({ id: req.id })],
    [
      "a chunk for no read",
      (c) => c.raw(encodeChunkFrame(5, Buffer.from("x"))),
    ],
    ["a broken frame", (c) => c.raw(Buffer.from([0, 0, 0, 0]))],
    ["the output ending", (c) => c.stdout.emit("end")],
    ["the agent exiting", (c) => c.emit("exit")],
    [
      "a stderr flood",
      (c) => c.stderr.emit("data", Buffer.alloc(LIMITS.maxStderrBytes + 1)),
    ],
  ];
  for (const [name, act] of violations) {
    it(`disposes of the agent on ${name}, failing what's outstanding`, async () => {
      const t = setup();
      const done = t.client.request("stat", { path: "/x" });
      const c = await t.child();
      while (c.received.length === 0) await t.tick();
      const settled = done.then(
        () => "resolved",
        (err) => err,
      );
      act(c, c.received[0]);
      const outcome = await settled;
      if (name === "a duplicate reply") {
        // the first reply settled it; the second disposed of the agent
        expect(outcome).toMatchObject({ code: "ENOENT" });
      } else {
        expect(outcome).toBeInstanceOf(AgentUnavailableError);
      }
      expect(c.killed).toBe(true);
      expect(t.killInContainer).toHaveBeenCalled();
    });
  }

  it("disposes of the agent when a read's chunks overrun its size", async () => {
    const t = setup();
    const read = t.client.request("readFile", { path: "/x" });
    const c = await t.child();
    await t.answer((req) => ({ id: req.id, ok: true, result: { size: 2 } }));
    c.raw(encodeChunkFrame(c.received[0].id, Buffer.from("abc")));
    await expect(read).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(c.killed).toBe(true);
  });

  it("times a request out, and disposes of the agent", async () => {
    LIMITS.requestTimeoutMs = 30;
    const t = setup();
    await expect(
      t.client.request("stat", { path: "/x" }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect((await t.child()).killed).toBe(true);
  });

  it("refuses an agent without a valid hello", async () => {
    LIMITS.helloTimeoutMs = 30;
    const t = setup({
      spawn: () => {
        const child = new FakeChild();
        setImmediate(() => child.say({ type: "hello", pid: -1 }));
        return child;
      },
    });
    await expect(
      t.client.request("stat", { path: "/x" }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("cools down after a disposal and bounds restarts", async () => {
    const t = setup();
    const first = t.client.request("stat", { path: "/x" });
    const c = await t.child();
    while (c.received.length === 0) await t.tick();
    c.emit("exit");
    await expect(first).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(t.client.request("stat", { path: "/x" })).rejects.toThrow(
      "cooling down",
    );
    for (let i = 0; i < 2; i++) {
      t.state.t += LIMITS.cooldownMs;
      const spawned = t.children.length;
      const again = t.client.request("stat", { path: "/x" });
      while (t.children.length === spawned) await t.tick();
      const ci = t.children[t.children.length - 1];
      while (ci.received.length === 0) await t.tick();
      ci.emit("exit");
      await expect(again).rejects.toBeInstanceOf(AgentUnavailableError);
    }
    t.state.t += LIMITS.cooldownMs;
    await expect(t.client.request("stat", { path: "/x" })).rejects.toThrow(
      "restarts too often",
    );
  });

  it("never waits for the in-container kill", async () => {
    const t = setup();
    const done = t.client.request("stat", { path: "/x" });
    const c = await t.child();
    while (c.received.length === 0) await t.tick();
    t.client.close();
    await expect(done).rejects.toBeInstanceOf(AgentUnavailableError);
    // killInContainer never resolves, yet close returned and the request failed
    expect(t.killInContainer).toHaveBeenCalledWith(
      GEN,
      expect.stringMatching(/^[0-9a-f]{32}$/),
    );
    await expect(t.client.request("stat", { path: "/x" })).rejects.toThrow(
      "disposed",
    );
  });
});
