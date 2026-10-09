import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatchedFileUtf8 } from "./safe-read";

const describeIfLinux = process.platform === "linux" ? describe : describe.skip;

describeIfLinux("readWatchedFileUtf8", () => {
  let dir: string;
  let outside: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-read-"));
    outside = await mkdtemp(join(tmpdir(), "safe-read-outside-"));
    await writeFile(join(outside, "secret.txt"), "OUTSIDE SECRET");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("reads a regular file", async () => {
    await writeFile(join(dir, "doc.txt"), "hello");
    expect(await readWatchedFileUtf8(join(dir, "doc.txt"))).toBe("hello");
  });

  it("refuses a symlink and never reads its outside target", async () => {
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    await expect(
      readWatchedFileUtf8(join(dir, "link.txt")),
    ).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses a FIFO without blocking", async () => {
    execFileSync("mkfifo", [join(dir, "pipe")]);
    await expect(readWatchedFileUtf8(join(dir, "pipe"))).rejects.toMatchObject({
      code: "EINVAL",
    });
  }, 5000);
});
