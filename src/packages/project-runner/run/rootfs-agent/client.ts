/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The host side of a project's rootfs agent: the trust boundary.

- One client serves one container generation: the container id, the
  runtime identity and the start counter it was spawned for. Before every
  request the generation is read again; any change disposes of the client
  and fails the request (retryable), and nothing goes to a new container
  through an old client.
- Before the first request, the agent's authority is checked from the host
  (checkAgentAuthority over facts the host reads itself, never the agent's
  word): the project uid and gid, no capabilities, no new privileges,
  seccomp, and the container's namespaces and cgroup. A mismatch refuses
  rootfs operations; it never falls back to host-direct access.
- The transport is bounded: frames (protocol.ts), outstanding requests,
  bytes per response, a timeout per request, stderr (counted and dropped,
  never parsed or logged), and the spawn rate. Any violation closes the
  pipe, fails what is outstanding and disposes of the agent; its process in
  the container is stopped too, under a timeout nobody waits for.
- Replies are checked against a schema per operation. No string from the
  agent is ever used as a host path.
*/

import { randomBytes } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import {
  encodeChunkFrame,
  encodeJsonFrame,
  FRAME_CHUNK,
  FrameDecoder,
  ProtocolError,
  ReplyTracker,
  type Frame,
} from "./protocol";

const logger = getLogger("project-runner:rootfs-agent");

export const LIMITS = {
  helloTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  maxStderrBytes: 64 * 1024,
  maxOutstanding: 32,
  maxFileBytes: 64 * 1024 * 1024,
  maxEntries: 100_000,
  maxPathBytes: 4096,
  spawnsPerMinute: 3,
  cooldownMs: 10_000,
  // byte-aware admission (@review, @vanta): what the clients buffer at
  // once (write data queued to an agent, read data an agent announced) is
  // bounded host-wide, and per project so that one can't starve the rest;
  // an operation that doesn't fit is refused (EAGAIN), never queued
  maxHostBufferedBytes: 256 * 1024 * 1024,
  maxProjectBufferedBytes: 128 * 1024 * 1024,
};

// shared by every project's client on this host
let hostBuffered = 0;
/** For tests: the host-wide bytes in use. */
export function hostBufferedBytes(): number {
  return hostBuffered;
}

export interface AgentGeneration {
  containerId: string;
  // bumped by project-runner at every start and stop of the project
  startCounter: number;
  uid: number;
  gid: number;
}

export interface AgentHostFacts {
  uid: number[]; // real, effective, saved, fs
  gid: number[];
  capEff: bigint;
  capAmb: bigint;
  noNewPrivs: number;
  seccomp: number;
  userns: string;
  mntns: string;
  cgroup: string;
}

export interface ContainerFacts {
  userns: string;
  mntns: string;
  cgroupPrefix: string;
}

export interface ChildLike {
  stdin: { write(data: Buffer): unknown; end(): unknown };
  stdout: { on(event: "data", cb: (data: Buffer) => void): unknown } & {
    on(event: "end", cb: () => void): unknown;
  };
  stderr: { on(event: "data", cb: (data: Buffer) => void): unknown };
  on(event: "exit", cb: () => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface AgentDeps {
  // the generation now; undefined when the project isn't running separate
  generation(): Promise<AgentGeneration | undefined>;
  spawn(gen: AgentGeneration, token: string): ChildLike;
  // read by the host for the agent's process, which the host finds by
  // itself (see host.ts pickAgentProcess), never by the agent's word
  hostFacts(gen: AgentGeneration, token: string): Promise<AgentHostFacts>;
  containerFacts(gen: AgentGeneration): Promise<ContainerFacts>;
  // stop the agent inside the container (bounded by the caller's timeout)
  killInContainer(gen: AgentGeneration, token: string): Promise<void>;
  now(): number;
}

export class AgentUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/** The agent's authority, from facts the host read itself. */
export function checkAgentAuthority(
  facts: AgentHostFacts,
  gen: AgentGeneration,
  container: ContainerFacts,
): string[] {
  const failures: string[] = [];
  if (facts.uid.length !== 4 || facts.uid.some((u) => u !== gen.uid)) {
    failures.push(`uids ${facts.uid.join(",")} are not all ${gen.uid}`);
  }
  if (facts.gid.length !== 4 || facts.gid.some((g) => g !== gen.gid)) {
    failures.push(`gids ${facts.gid.join(",")} are not all ${gen.gid}`);
  }
  if (facts.capEff !== 0n)
    failures.push("effective capabilities are not empty");
  if (facts.capAmb !== 0n) failures.push("ambient capabilities are not empty");
  if (facts.noNewPrivs !== 1) failures.push("no_new_privs is not set");
  if (facts.seccomp !== 2) failures.push("not under a seccomp filter");
  if (!container.userns || facts.userns !== container.userns) {
    failures.push("not in the container's user namespace");
  }
  if (!container.mntns || facts.mntns !== container.mntns) {
    failures.push("not in the container's mount namespace");
  }
  if (
    !container.cgroupPrefix ||
    !(
      facts.cgroup === container.cgroupPrefix ||
      facts.cgroup.startsWith(`${container.cgroupPrefix}/`)
    )
  ) {
    failures.push("not in the project's cgroup");
  }
  return failures;
}

const ERROR_CODE = /^E[A-Z0-9]{1,31}$/;
const TYPES = new Set(["file", "dir", "symlink", "other"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}
function isTime(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
function isPathString(v: unknown): v is string {
  return (
    typeof v === "string" &&
    !v.includes("\0") &&
    Buffer.byteLength(v) <= LIMITS.maxPathBytes
  );
}
function isName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v !== "" &&
    v !== "." &&
    v !== ".." &&
    !v.includes("/") &&
    !v.includes("\0") &&
    Buffer.byteLength(v) <= 255
  );
}

/** Checks a successful reply's result against its operation's schema. */
export function checkResult(op: string, result: unknown): unknown {
  const bad = (): never => {
    throw new ProtocolError(`malformed ${op} result`);
  };
  switch (op) {
    case "stat":
    case "lstat": {
      if (!isRecord(result) || !TYPES.has(result.type as string)) bad();
      const r = result as Record<string, unknown>;
      for (const k of ["mode", "uid", "gid", "size", "nlink", "ino"]) {
        if (!isCount(r[k])) bad();
      }
      for (const k of ["mtimeMs", "atimeMs", "ctimeMs"]) {
        if (!isTime(r[k])) bad();
      }
      return {
        type: r.type,
        mode: r.mode,
        uid: r.uid,
        gid: r.gid,
        size: r.size,
        nlink: r.nlink,
        ino: r.ino,
        mtimeMs: r.mtimeMs,
        atimeMs: r.atimeMs,
        ctimeMs: r.ctimeMs,
      };
    }
    case "readdir": {
      if (!isRecord(result) || !Array.isArray(result.entries)) bad();
      const r = result as { entries: unknown[]; truncated: unknown };
      if (typeof r.truncated !== "boolean") bad();
      if (r.entries.length > LIMITS.maxEntries) bad();
      const entries = r.entries.map((e) => {
        if (!isRecord(e) || !isName(e.name) || !TYPES.has(e.type as string)) {
          bad();
        }
        return { name: (e as any).name, type: (e as any).type };
      });
      return { entries, truncated: r.truncated };
    }
    case "readlink":
    case "realpath":
      if (!isPathString(result)) bad();
      return result;
    case "readFile":
      if (!isRecord(result) || !isCount(result.size)) bad();
      if ((result as any).size > LIMITS.maxFileBytes) bad();
      return { size: (result as any).size };
    case "mkdir":
    case "rmdir":
    case "unlink":
    case "rm":
    case "rename":
    case "chmod":
    case "utimes":
    case "writeFile":
    case "symlink":
      if (result !== null) bad();
      return null;
    default:
      return bad();
  }
}

export interface AgentError {
  code: string;
}

interface Pending {
  op: string;
  // bytes of the budgets this request holds (its write data, or its read's
  // announced size)
  reserved: number;
  // a read that didn't fit: its chunks are counted and dropped
  discard?: boolean;
  resolve: (value: { result: unknown; data?: Buffer }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  // readFile: the bytes still to come, and those received
  expect?: number;
  parts?: Buffer[];
  result?: unknown;
}

export class RootfsAgentClient {
  private child?: ChildLike;
  private gen?: AgentGeneration;
  private token = "";
  private decoder = new FrameDecoder();
  private tracker = new ReplyTracker(LIMITS.maxOutstanding);
  private pending = new Map<number, Pending>();
  private ready?: Promise<void>;
  private stderrBytes = 0;
  private spawns: number[] = [];
  private downUntil = 0;
  private disposed = false;

  constructor(
    readonly project_id: string,
    private readonly deps: AgentDeps,
  ) {}

  private buffered = 0;

  private reserve(n: number): boolean {
    if (n === 0) return true;
    if (
      this.buffered + n > LIMITS.maxProjectBufferedBytes ||
      hostBuffered + n > LIMITS.maxHostBufferedBytes
    ) {
      return false;
    }
    this.buffered += n;
    hostBuffered += n;
    return true;
  }

  private unreserve(n: number): void {
    this.buffered -= n;
    hostBuffered -= n;
  }

  /** For tests: this project's buffered bytes and pending requests. */
  inFlight(): { bufferedBytes: number; pending: number } {
    return { bufferedBytes: this.buffered, pending: this.pending.size };
  }

  /** One operation; data is a writeFile's content. */
  async request(
    op: string,
    args: Record<string, unknown>,
    data?: Buffer,
  ): Promise<{ result: unknown; data?: Buffer }> {
    // never queue more than the agent would accept (@review): refused here,
    // before any spawn, request id or pipe write
    if (data != null && data.length > LIMITS.maxFileBytes) {
      throw codedError("EFBIG", `rootfs operation ${op} too large`);
    }
    return await this.requestNow(op, args, data);
  }

  private async requestNow(
    op: string,
    args: Record<string, unknown>,
    data?: Buffer,
  ): Promise<{ result: unknown; data?: Buffer }> {
    let id: number;
    let reserved: number;
    try {
      await this.ensureReady();
      const gen = await this.deps.generation();
      if (!sameGeneration(gen, this.gen)) {
        this.dispose("the project's container changed");
        throw new AgentUnavailableError(
          "the project's container changed; try again",
          true,
        );
      }
      if (this.child == null) {
        throw new AgentUnavailableError("the rootfs agent went away", true);
      }
      // a read stays pending after its reply (its chunks still coming) though
      // its reply slot is closed: the pending count is bounded too (@review)
      if (this.pending.size >= LIMITS.maxOutstanding) {
        throw codedError("EAGAIN", "the rootfs agent is busy; try again");
      }
      // may refuse (too many outstanding): nothing is reserved yet
      id = this.tracker.open();
      // a write's data counts until its request ends (its queued pipe bytes
      // included, so stdin can't hold more than the budget). Reserved only
      // now and registered below with no await in between, so every later
      // end releases it through finish() (@review: no path may leak it)
      reserved = data?.length ?? 0;
      if (!this.reserve(reserved)) {
        this.tracker.abandon(id);
        throw codedError("EAGAIN", "the rootfs agent is busy; try again");
      }
    } catch (err) {
      // refused before its frame was written: the agent never saw it, so a
      // caller counting what may have changed can leave it out (N1)
      if (err != null && typeof err === "object") {
        (err as { unsent?: boolean }).unsent = true;
      }
      throw err;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.violation(`request ${op} timed out`);
      }, LIMITS.requestTimeoutMs);
      this.pending.set(id, { op, reserved, resolve, reject, timer });
      try {
        this.child!.stdin.write(
          encodeJsonFrame({
            id,
            op,
            ...args,
            ...(data ? { size: data.length } : {}),
          }),
        );
        if (data) {
          const CHUNK = 1024 * 1024;
          for (let i = 0; i < data.length; i += CHUNK) {
            this.child!.stdin.write(
              encodeChunkFrame(id, data.subarray(i, i + CHUNK)),
            );
          }
        }
      } catch (err) {
        this.violation(`write to the agent failed: ${err}`);
      }
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new AgentUnavailableError("the rootfs agent was disposed", true);
    }
    this.ready ??= this.start();
    try {
      await this.ready;
    } catch (err) {
      this.ready = undefined;
      throw err;
    }
  }

  private async start(): Promise<void> {
    const now = this.deps.now();
    if (now < this.downUntil) {
      throw new AgentUnavailableError("the rootfs agent is cooling down", true);
    }
    this.spawns = this.spawns.filter((t) => now - t < 60_000);
    if (this.spawns.length >= LIMITS.spawnsPerMinute) {
      throw new AgentUnavailableError(
        "the rootfs agent restarts too often",
        true,
      );
    }
    const gen = await this.deps.generation();
    if (gen == null) {
      throw new AgentUnavailableError(
        "the project isn't running with a separate runtime uid",
        false,
      );
    }
    this.spawns.push(now);
    this.gen = gen;
    this.token = randomBytes(16).toString("hex");
    this.decoder = new FrameDecoder();
    this.tracker = new ReplyTracker(LIMITS.maxOutstanding);
    this.stderrBytes = 0;
    const child = this.deps.spawn(gen, this.token);
    this.child = child;
    let hello!: (pid: number) => void;
    let helloFailed!: (err: Error) => void;
    const helloPid = new Promise<number>((resolve, reject) => {
      hello = resolve;
      helloFailed = reject;
    });
    let greeted = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      let frames: Frame[];
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        return this.violation(`${err}`);
      }
      for (const frame of frames) {
        if (this.child !== child) return;
        if (!greeted) {
          greeted = true;
          const v = frame.type === 1 ? (frame.value as any) : undefined;
          if (
            !isRecord(v) ||
            v.type !== "hello" ||
            !Number.isSafeInteger(v.pid) ||
            (v.pid as number) < 1
          ) {
            helloFailed(new ProtocolError("no valid hello"));
            return this.violation("no valid hello");
          }
          hello(v.pid as number);
          continue;
        }
        this.onFrame(frame);
      }
    });
    child.stdout.on("end", () => {
      if (this.child !== child) return;
      try {
        this.decoder.end();
      } catch {}
      this.violation("the agent's output ended");
      helloFailed(new ProtocolError("the agent's output ended"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > LIMITS.maxStderrBytes) {
        this.violation("too much stderr");
      }
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.violation("the agent exited");
      helloFailed(new ProtocolError("the agent exited"));
    });
    const timer = setTimeout(
      () => helloFailed(new ProtocolError("no hello in time")),
      LIMITS.helloTimeoutMs,
    );
    try {
      // the hello only says it's up; its pid is used for nothing
      await helloPid;
      // its authority, from the host's own reading
      const [facts, container] = await Promise.all([
        this.deps.hostFacts(gen, this.token),
        this.deps.containerFacts(gen),
      ]);
      const failures = checkAgentAuthority(facts, gen, container);
      if (failures.length > 0) {
        throw new AgentUnavailableError(
          `the rootfs agent doesn't have exactly the project user's authority (${failures.length} checks failed)`,
          false,
        );
      }
      if (!sameGeneration(await this.deps.generation(), gen)) {
        throw new AgentUnavailableError(
          "the project's container changed while the agent started",
          true,
        );
      }
      // it may have exited (or been disposed) during the checks above
      if (this.child !== child) {
        throw new AgentUnavailableError(
          "the rootfs agent went away while it started",
          true,
        );
      }
    } catch (err) {
      this.dispose(
        `start failed: ${err instanceof Error ? err.name : "error"}`,
      );
      throw err instanceof AgentUnavailableError
        ? err
        : new AgentUnavailableError(`the rootfs agent didn't start`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private onFrame(frame: Frame): void {
    try {
      if (frame.type === FRAME_CHUNK) {
        const p = this.pending.get(frame.id);
        if (p?.expect == null || frame.data.length > p.expect) {
          throw new ProtocolError(`unexpected chunk for ${frame.id}`);
        }
        if (!p.discard) p.parts!.push(frame.data);
        p.expect -= frame.data.length;
        if (p.expect === 0) this.settle(frame.id, p);
        return;
      }
      const reply = frame.value;
      // a reply to a read whose data is still coming is unsolicited
      const id = this.tracker.close(reply);
      const p = this.pending.get(id);
      if (!p) throw new ProtocolError(`no request ${id}`);
      const r = reply as Record<string, unknown>;
      if (r.ok === true) {
        const result = checkResult(p.op, r.result);
        if (p.op === "readFile") {
          p.result = result;
          p.expect = (result as { size: number }).size;
          p.parts = [];
          // the announced size must fit the budgets, else the chunks are
          // dropped as they come and the read is refused (EAGAIN)
          if (this.reserve(p.expect)) p.reserved += p.expect;
          else p.discard = true;
          if (p.expect === 0) this.settle(id, p);
          return;
        }
        p.result = result;
        this.settle(id, p);
      } else if (r.ok === false) {
        const e = r.error;
        if (
          !isRecord(e) ||
          typeof e.code !== "string" ||
          !ERROR_CODE.test(e.code)
        ) {
          throw new ProtocolError("malformed error");
        }
        this.finish(id, p);
        const err = new Error(`${e.code}: rootfs operation ${p.op} failed`);
        (err as any).code = e.code;
        p.reject(err);
      } else {
        throw new ProtocolError("reply is neither ok nor an error");
      }
    } catch (err) {
      this.violation(`${err}`);
    }
  }

  // every end of a request comes through here: its timer and its budget
  private finish(id: number, p: Pending): void {
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.unreserve(p.reserved);
    p.reserved = 0;
  }

  private settle(id: number, p: Pending): void {
    this.finish(id, p);
    if (p.discard) {
      p.reject(codedError("EAGAIN", "the rootfs agent is busy; try again"));
      return;
    }
    p.resolve(
      p.parts
        ? { result: p.result, data: Buffer.concat(p.parts) }
        : { result: p.result },
    );
  }

  private violation(why: string): void {
    if (this.disposed || !this.child) {
      // already gone: whatever is still pending fails now, never hangs
      this.rejectPending(why);
      return;
    }
    // counts and the class only: nothing the agent sent is logged
    logger.warn("rootfs agent disposed", {
      project_id: this.project_id,
      why: why.slice(0, 120),
      stderr_bytes: this.stderrBytes,
    });
    this.dispose(why);
  }

  /** Closes the pipe, fails what's outstanding, stops the agent. */
  dispose(why = "disposed"): void {
    const child = this.child;
    const gen = this.gen;
    const token = this.token;
    this.child = undefined;
    this.ready = undefined;
    this.downUntil = this.deps.now() + LIMITS.cooldownMs;
    this.rejectPending(why);
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
    if (gen) {
      // the in-container process too; nobody waits for this
      const bounded = Promise.race([
        this.deps.killInContainer(gen, token),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.()),
      ]);
      void bounded.catch(() => {});
    }
  }

  private rejectPending(why: string): void {
    for (const [id, p] of [...this.pending]) {
      this.finish(id, p);
      this.tracker.abandon(id);
      p.reject(new AgentUnavailableError(`rootfs agent: ${why}`, true));
    }
  }

  /** For good: no more spawns. */
  close(): void {
    this.dispose("closed");
    this.disposed = true;
  }
}

function codedError(code: string, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as any).code = code;
  return err;
}

function sameGeneration(
  a: AgentGeneration | undefined,
  b: AgentGeneration | undefined,
): boolean {
  return (
    a != null &&
    b != null &&
    a.containerId === b.containerId &&
    a.startCounter === b.startCounter &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}
