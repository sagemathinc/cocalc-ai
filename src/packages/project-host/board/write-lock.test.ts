import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBoardWriteLock,
  ensureBoardWriteLockFile,
  formatLockFileId,
  parseLockFileId,
  startBoardWriteFence,
} from "./write-lock";

let dir: string;
let path: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "board-write-lock-"));
  path = join(dir, "board-write.lock");
});

afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

// Another process holding the lock with flock(1): the same kernel lock any
// writer takes. Resolves once it holds it.
async function holdInOtherProcess(): Promise<ChildProcess> {
  const marker = join(dir, `held-${Math.random()}`);
  // -o: flock itself holds the lock, and its command doesn't inherit it, so
  // killing flock releases it.
  const child = spawn(
    "flock",
    ["-x", "-o", path, "sh", "-c", `touch ${marker}; sleep 60`],
    { stdio: "ignore" },
  );
  children.push(child);
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!fs.existsSync(marker))
    throw Error("the other process didn't take the lock");
  return child;
}

test("the lock gives a fresh 128-bit nonce, chosen after the lock is held", async () => {
  const a = await acquireBoardWriteLock({ path });
  expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(a.filesystem).toBe("btrfs");
  a.assertWritable();
  a.close();
  const b = await acquireBoardWriteLock({ path });
  expect(b.nonce).not.toBe(a.nonce);
  b.close();
});

test("a second holder in another process blocks the lock until it exits, even when killed", async () => {
  const other = await holdInOtherProcess();
  await expect(acquireBoardWriteLock({ path, waitSeconds: 1 })).rejects.toThrow(
    /held by another process/,
  );
  other.kill("SIGKILL");
  await new Promise((r) => other.once("exit", r));
  const a = await acquireBoardWriteLock({ path, waitSeconds: 5 });
  a.assertWritable();
  a.close();
});

test("a holder in this process excludes a second one (another open file description)", async () => {
  const a = await acquireBoardWriteLock({ path });
  await expect(acquireBoardWriteLock({ path, waitSeconds: 1 })).rejects.toThrow(
    /held by another process/,
  );
  a.close();
  const b = await acquireBoardWriteLock({ path, waitSeconds: 5 });
  b.close();
});

test("children this process starts later don't inherit the lock", async () => {
  const a = await acquireBoardWriteLock({ path });
  // A long-lived child of the holder.
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  a.close();
  // The lock is free although the child still runs.
  const b = await acquireBoardWriteLock({ path, waitSeconds: 2 });
  b.close();
});

test("the lock file is never truncated or replaced by taking it", async () => {
  fs.writeFileSync(path, "keep");
  const before = fs.statSync(path);
  const a = await acquireBoardWriteLock({ path });
  const after = fs.statSync(path);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect(fs.readFileSync(path, "utf8")).toBe("keep");
  a.close();
  expect(fs.existsSync(path)).toBe(true);
});

test("the recorded identity must match, checked before any nonce", async () => {
  const id = ensureBoardWriteLockFile(path);
  expect(parseLockFileId(formatLockFileId(id))).toEqual(id);
  const a = await acquireBoardWriteLock({ path, expected: id });
  a.close();
  await expect(
    acquireBoardWriteLock({ path, expected: { dev: id.dev, ino: id.ino + 1 } }),
  ).rejects.toThrow(/not the lock file the project host created/);
});

test("a lock file replaced after startup is refused when taken", async () => {
  const id = ensureBoardWriteLockFile(path);
  fs.renameSync(path, path + ".old");
  fs.writeFileSync(path, "");
  await expect(acquireBoardWriteLock({ path, expected: id })).rejects.toThrow(
    /not the lock file/,
  );
});

test("a replacement or removal while held is detected, and writes stop", async () => {
  const a = await acquireBoardWriteLock({ path });
  a.assertWritable();
  // Replaced by rename: the path names another inode.
  fs.writeFileSync(path + ".new", "");
  fs.renameSync(path + ".new", path);
  expect(() => a.assertWritable()).toThrow(/replaced/);
  a.close();

  const b = await acquireBoardWriteLock({ path });
  fs.unlinkSync(path);
  expect(() => b.assertWritable()).toThrow(/removed/);
  b.close();
  expect(() => b.assertWritable()).toThrow(/released/);
});

test("only host-local filesystems are trusted", async () => {
  // overlay, nfs, fuse, cifs
  for (const type of [0x794c7630, 0x6969, 0x65735546, 0xff534d42]) {
    await expect(
      acquireBoardWriteLock({ path, filesystemType: type }),
    ).rejects.toThrow(/can't be trusted/);
  }
});

const overlayDir = "/scratch";
const onOverlay =
  fs.existsSync(overlayDir) && fs.statfsSync(overlayDir).type === 0x794c7630;
(onOverlay ? test : test.skip)(
  "a lock file on a real overlay filesystem is refused",
  async () => {
    const d = fs.mkdtempSync(join(overlayDir, "board-write-lock-"));
    try {
      await expect(
        acquireBoardWriteLock({ path: join(d, "board-write.lock") }),
      ).rejects.toThrow(/can't be trusted/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  },
);

async function until(f: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the controller waits while another process holds the lock, then takes it", async () => {
  const other = await holdInOtherProcess();
  const c = startBoardWriteFence({
    path,
    retryMs: 50,
    acquire: (opts) => acquireBoardWriteLock({ ...opts, waitSeconds: 0.2 }),
  });
  try {
    await new Promise((r) => setTimeout(r, 500));
    expect(c.fence()).toBeUndefined();
    expect(c.status()).toMatchObject({
      ok: false,
      reason: "board-lock-waiting",
    });
    other.kill("SIGKILL");
    await until(() => c.fence() != null);
    expect(c.status()).toMatchObject({ ok: true });
  } finally {
    c.close();
  }
});

test("the controller fails closed for good on an invalid lock file", async () => {
  const id = ensureBoardWriteLockFile(path);
  const c = startBoardWriteFence({
    path,
    expected: { dev: id.dev, ino: id.ino + 1 },
    retryMs: 50,
  });
  try {
    await until(
      () =>
        !c.status().ok && (c.status() as any).reason === "board-lock-invalid",
    );
    expect(c.fence()).toBeUndefined();
  } finally {
    c.close();
  }
});

test("the controller stops board writes when the lock file is replaced after startup", async () => {
  const c = startBoardWriteFence({ path, recheckMs: 50 });
  try {
    await until(() => c.fence() != null);
    fs.writeFileSync(path + ".new", "");
    fs.renameSync(path + ".new", path);
    await until(() => c.fence() == null);
    expect(c.status()).toMatchObject({
      ok: false,
      reason: "board-lock-invalid",
    });
  } finally {
    c.close();
  }
});
