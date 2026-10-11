import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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

  describe("with a containment base", () => {
    it("reads a regular file inside the base", async () => {
      await writeFile(join(dir, "in.txt"), "inside");
      expect(await readWatchedFileUtf8(join(dir, "in.txt"), dir)).toBe(
        "inside",
      );
    });

    it("refuses a file reached through a swapped-in parent symlink", async () => {
      // O_NOFOLLOW does not catch this: the leaf is a real file, but its parent
      // component is a symlink pointing outside the base.
      const base = join(dir, "base");
      await mkdir(base);
      symlinkSync(outside, join(base, "sub"));
      await expect(
        readWatchedFileUtf8(join(base, "sub", "secret.txt"), base),
      ).rejects.toMatchObject({ code: "EACCES" });
    });

    it("reads in-base names that start with two dots", async () => {
      const base = join(dir, "base3");
      await mkdir(join(base, "..hidden"), { recursive: true });
      await writeFile(join(base, "..hidden", "doc.txt"), "dots");
      await writeFile(join(base, "..notes.txt"), "more dots");
      expect(
        await readWatchedFileUtf8(join(base, "..hidden", "doc.txt"), base),
      ).toBe("dots");
      expect(await readWatchedFileUtf8(join(base, "..notes.txt"), base)).toBe(
        "more dots",
      );
    });

    it("refuses a file in a sibling of the base", async () => {
      const base = join(dir, "base4");
      await mkdir(base);
      await writeFile(join(dir, "sibling.txt"), "sibling");
      await expect(
        readWatchedFileUtf8(join(dir, "sibling.txt"), base),
      ).rejects.toMatchObject({ code: "EACCES" });
    });

    it("allows a regular file through an in-base symlinked parent", async () => {
      const base = join(dir, "base2");
      await mkdir(join(base, "real"), { recursive: true });
      await writeFile(join(base, "real", "doc.txt"), "ok");
      symlinkSync(join(base, "real"), join(base, "link"));
      expect(
        await readWatchedFileUtf8(join(base, "link", "doc.txt"), base),
      ).toBe("ok");
    });
  });
});
