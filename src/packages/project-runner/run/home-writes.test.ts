import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { START_PROJECT_SSH } from "@cocalc/conat/project/runner/constants";
import { PROJECT_STARTUP_SCRIPT_PATH } from "@cocalc/util/project-startup-script";

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

import { dataPath, secretTokenPath } from "./env";
import { ensureConfFilesExists, setupDataPath, writeSecretToken } from "./util";
import { writeStartupScripts } from "./startup-scripts";

describe("project start writes into the home", () => {
  let home: string;
  let outside: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "home-writes-"));
    // Stands in for a host directory or another project's volume.
    outside = await mkdtemp(join(tmpdir(), "home-writes-outside-"));
    await writeFile(join(outside, "precious"), "keep me\n");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const outsideUnchanged = async () => {
    expect(await readdir(outside)).toEqual(["precious"]);
    expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");
  };

  it("recreates the data dir empty and writes a private secret token", async () => {
    await mkdir(join(dataPath(home), "old"), { recursive: true });
    await writeFile(join(dataPath(home), "old", "f"), "x");
    await setupDataPath(home);
    expect(await readdir(dataPath(home))).toEqual([]);
    await writeSecretToken(home, "s3cret");
    expect(await readFile(secretTokenPath(home), "utf8")).toBe("s3cret");
    expect((await stat(secretTokenPath(home))).mode & 0o777).toBe(0o600);
  });

  it("recreates a data dir containing an empty unreadable secrets mount target", async () => {
    const secrets = join(dataPath(home), "secrets");
    await mkdir(dataPath(home), { recursive: true });
    await mkdir(secrets, { mode: 0o000 });
    await setupDataPath(home);
    expect(await readdir(dataPath(home))).toEqual([]);
  });

  it("never follows a symlink planted at the secrets mount target", async () => {
    await mkdir(dataPath(home), { recursive: true });
    await symlink(outside, join(dataPath(home), "secrets"));
    await setupDataPath(home);
    expect(await readdir(dataPath(home))).toEqual([]);
    await outsideUnchanged();
  });

  it("still fails closed for a non-empty unreadable secrets directory", async () => {
    if (process.getuid?.() === 0) return;
    const secrets = join(dataPath(home), "secrets");
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "file"), "x");
    await chmod(secrets, 0o000);
    await expect(setupDataPath(home)).rejects.toThrow(/EACCES/);
    await chmod(secrets, 0o700);
  });

  it("removes a symlinked data dir itself, not what it points to", async () => {
    await mkdir(join(dataPath(home), ".."), { recursive: true });
    await symlink(outside, dataPath(home));
    await setupDataPath(home);
    expect((await stat(dataPath(home))).isDirectory()).toBe(true);
    await outsideUnchanged();
  });

  it.each([".cache", ".cache/cocalc"])(
    "never deletes or writes outside when %s is a symlink",
    async (link) => {
      await mkdir(join(home, link, ".."), { recursive: true });
      // The outside tree has the shape the data dir would resolve to.
      const rest = join(dataPath(home)).slice(join(home, link).length + 1);
      await mkdir(join(outside, rest), { recursive: true });
      await writeFile(join(outside, rest, "victim"), "other project\n");
      await symlink(outside, join(home, link));

      await expect(setupDataPath(home)).rejects.toThrow(/ELOOP/);
      await expect(writeSecretToken(home, "s3cret")).rejects.toThrow(/ELOOP/);
      expect(await readFile(join(outside, rest, "victim"), "utf8")).toBe(
        "other project\n",
      );
      await expect(
        stat(join(outside, rest, "secret-token")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("writes startup scripts, creating startup.sh only once", async () => {
    await writeStartupScripts(home);
    expect((await stat(join(home, START_PROJECT_SSH))).mode & 0o777).toBe(
      0o700,
    );
    const startup = join(home, PROJECT_STARTUP_SCRIPT_PATH);
    await writeFile(startup, "# mine\n");
    await writeStartupScripts(home);
    expect(await readFile(startup, "utf8")).toBe("# mine\n");
  });

  it.each([".ssh", ".ssh/.cocalc"])(
    "startup fails closed and never writes outside when %s is a symlink",
    async (link) => {
      await mkdir(join(home, link, ".."), { recursive: true });
      await symlink(outside, join(home, link));
      await expect(writeStartupScripts(home)).rejects.toThrow(/ELOOP/);
      await outsideUnchanged();
    },
  );

  it.each([
    [".local", "outside the home"],
    [".local/share/cocalc", "outside the home"],
    [".local", "inside the home (relative, as users do)"],
  ])(
    "skips startup.sh when %s is a symlink %s, writing nothing through it",
    async (link, where) => {
      await mkdir(join(home, link, ".."), { recursive: true });
      if (where.startsWith("inside")) {
        await mkdir(join(home, "portable-scripts", ".local"), {
          recursive: true,
        });
        await symlink("portable-scripts/.local", join(home, link));
      } else {
        await symlink(outside, join(home, link));
      }
      await writeStartupScripts(home);
      expect((await stat(join(home, START_PROJECT_SSH))).isFile()).toBe(true);
      await outsideUnchanged();
      if (where.startsWith("inside")) {
        expect(await readdir(join(home, "portable-scripts", ".local"))).toEqual(
          [],
        );
      }
    },
  );

  it("replaces an escaping .bashrc symlink without touching its target", async () => {
    await symlink(join(outside, "precious"), join(home, ".bashrc"));
    await ensureConfFilesExists(home);
    expect((await stat(join(home, ".bashrc"))).isFile()).toBe(true);
    await outsideUnchanged();
  });
});
