import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

jest.mock("@cocalc/backend/data", () => ({
  root: process.cwd(),
}));

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("./env", () => {
  const { join } = require("node:path");
  return {
    dataPath: (HOME: string) => join(HOME, ".local", "share", "cocalc"),
    secretTokenPath: (HOME: string) =>
      join(HOME, ".local", "share", "cocalc", "secret-token"),
  };
});

describe("ensureConfFilesExists", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cocalc-runner-util-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("replaces legacy absolute shell symlinks with regular files", async () => {
    await writeFile(join(home, ".bashrc"), "# restored bashrc\n");
    await symlink("/home/user/.bashrc", join(home, ".bash_profile"));

    const { ensureConfFilesExists } = await import("./util");
    await ensureConfFilesExists(home);

    const profileStat = await lstat(join(home, ".bash_profile"));
    expect(profileStat.isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, ".bash_profile"), "utf8")).toContain(
      ".bashrc",
    );
  });

  it("preserves safe in-project shell symlinks", async () => {
    await writeFile(join(home, ".bashrc"), "# restored bashrc\n");
    await symlink(".bashrc", join(home, ".bash_profile"));

    const { ensureConfFilesExists } = await import("./util");
    await ensureConfFilesExists(home);

    const profileStat = await lstat(join(home, ".bash_profile"));
    expect(profileStat.isSymbolicLink()).toBe(true);
    expect(await readFile(join(home, ".bash_profile"), "utf8")).toBe(
      "# restored bashrc\n",
    );
  });
});
