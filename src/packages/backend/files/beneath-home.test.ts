import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsBeneathHome,
  mkdirBeneathHome,
  readFileBeneathHome,
  rmBeneathHome,
  writeFileBeneathHome,
} from "./beneath-home";

describe("beneath-home file access", () => {
  let home: string;
  let outside: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "beneath-home-"));
    outside = await mkdtemp(join(tmpdir(), "beneath-outside-"));
    await writeFile(join(outside, "secret"), "host secret\n");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("writes, reads and detects files, creating private directories", () => {
    expect(existsBeneathHome(home, "a/b/file")).toBe(false);
    writeFileBeneathHome(home, "a/b/file", "hello\n", { mode: 0o640 });
    expect(existsBeneathHome(home, "a/b/file")).toBe(true);
    expect(readFileBeneathHome(home, "a/b/file")).toBe("hello\n");
    expect(readFileBeneathHome(home, "a/b/missing")).toBeUndefined();
  });

  it("sets file and directory modes", async () => {
    writeFileBeneathHome(home, "d/file", "x", { mode: 0o640, dirMode: 0o750 });
    expect((await stat(join(home, "d/file"))).mode & 0o777).toBe(0o640);
    expect((await stat(join(home, "d"))).mode & 0o777).toBe(0o750);
  });

  it("refuses a symlinked parent directory for every operation", async () => {
    await symlink(outside, join(home, "link"));
    expect(() => existsBeneathHome(home, "link/secret")).toThrow(/ELOOP/);
    expect(() => readFileBeneathHome(home, "link/secret")).toThrow(/ELOOP/);
    expect(() => writeFileBeneathHome(home, "link/secret", "pwned")).toThrow(
      /ELOOP/,
    );
    expect(await readFile(join(outside, "secret"), "utf8")).toBe(
      "host secret\n",
    );
  });

  it("treats a symlinked final file as present but unreadable, and replaces it", async () => {
    await mkdir(join(home, "d"));
    await symlink(join(outside, "secret"), join(home, "d/file"));
    expect(existsBeneathHome(home, "d/file")).toBe(true);
    expect(readFileBeneathHome(home, "d/file")).toBeUndefined();
    writeFileBeneathHome(home, "d/file", "mine\n");
    expect(await readFile(join(home, "d/file"), "utf8")).toBe("mine\n");
    expect(await readFile(join(outside, "secret"), "utf8")).toBe(
      "host secret\n",
    );
  });

  it("refuses paths that leave the home", () => {
    expect(() => writeFileBeneathHome(home, "../escape", "x")).toThrow();
    expect(() => writeFileBeneathHome(home, join(outside, "x"), "x")).toThrow();
  });

  it("keeps an existing entry with noReplace", () => {
    expect(writeFileBeneathHome(home, "f", "first", { noReplace: true })).toBe(
      true,
    );
    expect(writeFileBeneathHome(home, "f", "second", { noReplace: true })).toBe(
      false,
    );
    expect(readFileBeneathHome(home, "f")).toBe("first");
  });

  it("removes trees without following symlinks, and refuses symlinked parents", async () => {
    mkdirBeneathHome(home, "a/b");
    await symlink(outside, join(home, "a/b/link"));
    await rmBeneathHome(home, "a");
    expect(existsBeneathHome(home, "a")).toBe(false);
    await rmBeneathHome(home, "a/missing/deep");
    await symlink(outside, join(home, "p"));
    await expect(rmBeneathHome(home, "p/secret")).rejects.toThrow(/ELOOP/);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe(
      "host secret\n",
    );
  });

  it("bounds reads", () => {
    writeFileBeneathHome(home, "big", "x".repeat(100));
    expect(() => readFileBeneathHome(home, "big", 10)).toThrow(/larger/);
  });
});
