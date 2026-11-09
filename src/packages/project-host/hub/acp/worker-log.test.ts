import path from "node:path";
import { tmpdir } from "node:os";
import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { capAcpWorkerLog } from "./worker-log";

let dir: string;
let logPath: string;
let historyDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "acp-worker-log-"));
  logPath = path.join(dir, "logs", "acp-worker.log");
  historyDir = path.join(dir, "log-history");
  await mkdir(path.dirname(logPath));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const now = new Date("2026-11-09T18:00:00.000Z");

test("leaves a missing or small log alone", async () => {
  expect(
    await capAcpWorkerLog({ logPath, historyDir, maxBytes: 10, now }),
  ).toBeUndefined();
  await writeFile(logPath, "0123456789");
  expect(
    await capAcpWorkerLog({ logPath, historyDir, maxBytes: 10, now }),
  ).toBeUndefined();
  expect(await readFile(logPath, "utf8")).toBe("0123456789");
  await expect(readdir(historyDir)).rejects.toThrow();
});

test("keeps the tail and truncates in place under an append-mode writer", async () => {
  // The worker's stdout: opened once, in append mode, and never reopened.
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, "old-".repeat(10) + "TAIL-OF-LOG");
    const archive = await capAcpWorkerLog({
      logPath,
      historyDir,
      maxBytes: 11,
      now,
    });
    expect(archive).toBe(
      path.join(historyDir, "acp-worker-2026-11-09T18-00-00-000Z.log"),
    );
    expect(await readFile(archive!, "utf8")).toBe("TAIL-OF-LOG");
    expect((await stat(archive!)).mode & 0o777).toBe(0o600);
    expect((await stat(logPath)).size).toBe(0);
    // The writer's next line lands at the new start: no sparse hole.
    writeSync(fd, "next line\n");
    expect(await readFile(logPath, "utf8")).toBe("next line\n");
  } finally {
    closeSync(fd);
  }
});

test("keeps only the newest archives, and never touches other logs", async () => {
  await mkdir(historyDir);
  for (const name of [
    "acp-worker-2026-11-01T00-00-00-000Z.log",
    "acp-worker-2026-11-02T00-00-00-000Z.log",
    "acp-worker-2026-11-03T00-00-00-000Z.log",
    "project-host-2026-11-01T00-00-00-000Z.log",
  ])
    await writeFile(path.join(historyDir, name), "x");
  await writeFile(logPath, "0123456789abc");
  await capAcpWorkerLog({ logPath, historyDir, maxBytes: 5, keep: 2, now });
  expect((await readdir(historyDir)).sort()).toEqual([
    "acp-worker-2026-11-03T00-00-00-000Z.log",
    "acp-worker-2026-11-09T18-00-00-000Z.log",
    "project-host-2026-11-01T00-00-00-000Z.log",
  ]);
});

test("never overwrites an archive with the same timestamp", async () => {
  await writeFile(logPath, "first-log");
  const a = await capAcpWorkerLog({ logPath, historyDir, maxBytes: 3, now });
  await writeFile(logPath, "second-log");
  const b = await capAcpWorkerLog({ logPath, historyDir, maxBytes: 3, now });
  expect(a).not.toBe(b);
  expect(b).toBe(
    path.join(historyDir, "acp-worker-2026-11-09T18-00-00-000Z-1.log"),
  );
  expect(await readFile(a!, "utf8")).toBe("log");
  expect(await readFile(b!, "utf8")).toBe("log");
});
