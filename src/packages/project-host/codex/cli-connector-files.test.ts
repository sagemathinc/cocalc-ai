import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetSiteCliConnectorsCache,
  siteCliConnectors,
  STALE_CLI_TOKEN_MS,
  sweepStaleCliConnectorTokens,
  applyCliConnectorEnv,
  syncCliConnectorTokens,
  writeCliConnectorTools,
} from "./cli-connector-files";
import { BeneathDir } from "../beneath-copy";

let dir: string;
let realBin: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "cli-connector-files-"));
  realBin = join(dir, "real-bin");
  await fs.mkdir(realBin);
  // Stand-ins for the real commands: print the token they were given.
  await fs.writeFile(
    join(realBin, "gh"),
    '#!/bin/sh\n[ "$1" = fail ] && exit 4\necho "gh:${GH_TOKEN-unset}:$*"\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    join(realBin, "cf"),
    '#!/bin/sh\necho "cf:${CLOUDFLARE_API_TOKEN-unset}"\n',
    { mode: 0o755 },
  );
  await writeCliConnectorTools(new BeneathDir(dir));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function env(): Record<string, string> {
  const result: Record<string, string> = {
    PATH: `${realBin}:/usr/bin:/bin`,
    HOME: dir,
  };
  applyCliConnectorEnv(result, dir);
  return result;
}

function run(command: string, args: string[] = [], input?: string): string {
  return execFileSync(command, args, { env: env(), input, encoding: "utf8" });
}

const tokens = [
  {
    connector: "github" as const,
    token: "gho_test",
    expires_at: Date.now() + 60_000,
    description: "@octo",
  },
  {
    connector: "cloudflare" as const,
    token: "cf_test",
    expires_at: Date.now() + 60_000,
    description: "API token",
  },
];

it("puts the wrappers first on PATH, names their directory, and leaves git config alone", () => {
  const e: Record<string, string> = { PATH: "/usr/bin" };
  applyCliConnectorEnv(e, "/c");
  expect(e.PATH).toBe("/c/cli/bin:/usr/bin");
  // Not a secret: a login shell's profile may reorder PATH, and commands
  // put the wrappers first again from this.
  expect(e.COCALC_CONNECTOR_BIN).toBe("/c/cli/bin");
  expect(Object.keys(e).sort()).toEqual(["COCALC_CONNECTOR_BIN", "PATH"]);
  applyCliConnectorEnv(e, "/c");
  expect(e.PATH).toBe("/c/cli/bin:/usr/bin");
});

it("runs the real command unchanged when no connector is on", () => {
  expect(run("gh", ["pr", "list"]).trim()).toBe("gh:unset:pr list");
  expect(run("cf").trim()).toBe("cf:unset");
});

it("supplies the tokens during a turn and removes them after", async () => {
  await syncCliConnectorTokens(new BeneathDir(dir), tokens);
  expect(run("gh", ["api", "user"]).trim()).toBe("gh:gho_test:api user");
  expect(run("cf").trim()).toBe("cf:cf_test");
  const stat = await fs.stat(join(dir, "cli", "github-token"));
  expect(stat.mode & 0o777).toBe(0o600);

  await syncCliConnectorTokens(new BeneathDir(dir), [tokens[1]]);
  expect(run("gh").trim()).toBe("gh:unset:");
  expect(run("cf").trim()).toBe("cf:cf_test");

  await syncCliConnectorTokens(new BeneathDir(dir), []);
  expect(run("cf").trim()).toBe("cf:unset");
  expect(await fs.readdir(join(dir, "cli"))).toEqual(["bin"]);
});

it("fails closed: a failed write leaves no token files", async () => {
  // A directory where the Cloudflare token goes makes that write fail.
  await fs.mkdir(join(dir, "cli", "cloudflare-token", "x"), {
    recursive: true,
  });
  await expect(
    syncCliConnectorTokens(new BeneathDir(dir), tokens),
  ).rejects.toThrow();
  await expect(fs.stat(join(dir, "cli", "github-token"))).rejects.toThrow();
  expect(run("gh").trim()).toBe("gh:unset:");
});

it("ignores malformed tokens", async () => {
  await syncCliConnectorTokens(new BeneathDir(dir), [
    { ...tokens[0], token: "a b" },
  ]);
  expect(run("gh").trim()).toBe("gh:unset:");
});

it("says so when the real command is missing", () => {
  expect(() =>
    execFileSync("wrangler", [], {
      env: env(),
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).toThrow(/wrangler: not installed/);
});

describe("saying what is going on", () => {
  const sh = (command: string, args: string[], cwd?: string) =>
    spawnSync(command, args, { env: env(), encoding: "utf8", cwd });

  it("gh auth status names the connector during a turn", async () => {
    expect(sh("gh", ["auth", "status"]).stderr).toBe("");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    const status = sh("gh", ["auth", "status"]);
    expect(status.stderr).toContain(
      "signed in via the CoCalc GitHub connector for this agent turn",
    );
    expect(status.stdout.trim()).toBe("gh:gho_test:auth status");
    // Only for the status command.
    expect(sh("gh", ["pr", "list"]).stderr).toBe("");
  });

  it("a failure without a token says the connector is only active in a turn", async () => {
    const failed = sh("gh", ["fail"]);
    expect(failed.status).toBe(4);
    expect(failed.stderr).toContain(
      "the CoCalc GitHub connector is not active here",
    );
    expect(failed.stderr).toContain("not in sensors or background jobs");
    // Success is quiet, and with a token there is nothing to explain.
    expect(sh("gh", ["pr", "list"]).stderr).toBe("");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    const withToken = sh("gh", ["fail"]);
    expect(withToken.status).toBe(4);
    expect(withToken.stderr).toBe("");
  });

  it("git uses https for git@github.com: remotes, only during a turn", async () => {
    const repo = join(dir, "repo");
    await fs.mkdir(repo);
    sh("git", ["init", "-q"], repo);
    sh("git", ["remote", "add", "origin", "git@github.com:o/r.git"], repo);
    sh("git", ["remote", "add", "other", "ssh://git@github.com/o/s.git"], repo);
    const url = (remote: string) =>
      sh("git", ["remote", "get-url", remote], repo).stdout.trim();
    expect(url("origin")).toBe("git@github.com:o/r.git");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    expect(url("origin")).toBe("https://github.com/o/r.git");
    expect(url("other")).toBe("https://github.com/o/s.git");
    await syncCliConnectorTokens(new BeneathDir(dir), []);
    expect(url("origin")).toBe("git@github.com:o/r.git");
  });

  it("a failed git remote command without a token says why; local ones do not", () => {
    const missing = join(dir, "no-such-repo");
    const remote = sh("git", ["-c", "core.askPass=true", "ls-remote", missing]);
    expect(remote.status).not.toBe(0);
    expect(remote.stderr).toContain(
      "git: note: the CoCalc GitHub connector is not active here",
    );
    const local = sh("git", ["-C", missing, "status"]);
    expect(local.status).not.toBe(0);
    expect(local.stderr).not.toContain("CoCalc GitHub connector");
  });
});

describe("git credential helper", () => {
  const helper = () => join(dir, "cli", "bin", "git-credential-cocalc");

  it("answers only for https://github.com, and only during a turn", async () => {
    const ask = (host: string, protocol = "https") =>
      run(helper(), ["get"], `protocol=${protocol}\nhost=${host}\n\n`);
    expect(ask("github.com")).toBe("");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    expect(ask("github.com")).toBe(
      "username=x-access-token\npassword=gho_test\n",
    );
    expect(ask("gitlab.com")).toBe("");
    expect(ask("github.com.evil.example")).toBe("");
    expect(ask("github.com", "http")).toBe("");
    expect(
      run(helper(), ["store"], "protocol=https\nhost=github.com\n\n"),
    ).toBe("");
  });

  it("reads all of its input before exiting, for store and erase too", async () => {
    // more than a pipe buffer: a helper that exits without reading it makes
    // the writer fail with EPIPE every time, not only under load
    const big = `protocol=https\nhost=github.com\npassword=${"x".repeat(300_000)}\n\n`;
    for (const action of ["store", "erase", "get"]) {
      expect(run(helper(), [action], big)).toBe("");
    }
  });

  it("is used by git itself, only during a turn", async () => {
    const fill = () =>
      run("git", ["credential", "fill"], "protocol=https\nhost=github.com\n\n");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    expect(fill()).toContain("password=gho_test");
    await syncCliConnectorTokens(new BeneathDir(dir), []);
    // Without the connector, git is unchanged: no helper, so no credentials.
    expect(() =>
      execFileSync("git", ["credential", "fill"], {
        env: { ...env(), GIT_TERMINAL_PROMPT: "0" },
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("never lets an existing helper store the connector token", async () => {
    await fs.writeFile(
      join(dir, ".gitconfig"),
      "[credential]\n\thelper = store\n",
    );
    const store = join(dir, ".git-credentials");
    await fs.writeFile(store, "https://user:own-password@gitlab.com\n");
    await syncCliConnectorTokens(new BeneathDir(dir), tokens);
    const filled = run(
      "git",
      ["credential", "fill"],
      "protocol=https\nhost=github.com\n\n",
    );
    expect(filled).toContain("password=gho_test");
    // git approves credentials that worked; that must not reach "store".
    run("git", ["credential", "approve"], filled + "\n");
    expect(await fs.readFile(store, "utf8")).not.toContain("gho_test");
    // Other hosts still use the project's own helpers.
    expect(
      run("git", ["credential", "fill"], "protocol=https\nhost=gitlab.com\n\n"),
    ).toContain("password=own-password");
  });
});

describe("sweeping tokens of dead leases", () => {
  it("removes stale token files of other leases only", async () => {
    const runtime = await fs.mkdtemp(join(tmpdir(), "cli-runtime-"));
    try {
      const lease = (name: string) => join(runtime, `.cocalc-agent-${name}`);
      const leaseDir = (name: string) =>
        new BeneathDir(runtime, `.cocalc-agent-${name}`);
      for (const name of ["dead", "live", "own"]) {
        leaseDir(name).mkdir();
        await writeCliConnectorTools(leaseDir(name));
        await syncCliConnectorTokens(leaseDir(name), tokens);
      }
      const old = new Date(Date.now() - STALE_CLI_TOKEN_MS - 60_000);
      for (const name of ["dead", "own"]) {
        for (const file of ["github-token", "cloudflare-token"]) {
          await fs.utimes(join(lease(name), "cli", file), old, old);
        }
      }
      await expect(
        sweepStaleCliConnectorTokens({
          runtimeDir: new BeneathDir(runtime),
          ownLeaseName: ".cocalc-agent-own",
        }),
      ).resolves.toBe(2);
      expect(await fs.readdir(join(lease("dead"), "cli"))).toEqual(["bin"]);
      expect((await fs.readdir(join(lease("live"), "cli"))).sort()).toEqual([
        "bin",
        "cloudflare-token",
        "github-token",
      ]);
      expect((await fs.readdir(join(lease("own"), "cli"))).length).toBe(3);
    } finally {
      await fs.rm(runtime, { recursive: true, force: true });
    }
  });

  it("never sweeps through a symlink the project put on the way", async () => {
    const target = await fs.mkdtemp(join(tmpdir(), "sweep-target-"));
    const home = await fs.mkdtemp(join(tmpdir(), "sweep-home-"));
    try {
      const stale = join(target, ".cocalc-agent-other", "cli");
      await fs.mkdir(stale, { recursive: true });
      const token = join(stale, "github-token");
      await fs.writeFile(token, "x");
      const old = new Date(Date.now() - STALE_CLI_TOKEN_MS - 60_000);
      await fs.utimes(token, old, old);
      // The project's runtime directory is a symlink to another place.
      await fs.symlink(target, join(home, "runtime"));
      await expect(
        sweepStaleCliConnectorTokens({
          runtimeDir: new BeneathDir(home, "runtime"),
          ownLeaseName: ".cocalc-agent-own",
        }),
      ).resolves.toBe(0);
      await expect(fs.readFile(token, "utf8")).resolves.toBe("x");
    } finally {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("is harmless when the runtime directory does not exist", async () => {
    await expect(
      sweepStaleCliConnectorTokens({
        runtimeDir: new BeneathDir(dir, "missing"),
        ownLeaseName: "x",
      }),
    ).resolves.toBe(0);
  });
});

describe("site connectors", () => {
  beforeEach(() => resetSiteCliConnectorsCache());

  it("writes only the wrappers of connectors the site set up", async () => {
    const only = await fs.mkdtemp(join(tmpdir(), "cli-only-cf-"));
    try {
      await writeCliConnectorTools(new BeneathDir(only), ["cloudflare"]);
      expect((await fs.readdir(join(only, "cli", "bin"))).sort()).toEqual([
        "cf",
        "wrangler",
      ]);
    } finally {
      await fs.rm(only, { recursive: true, force: true });
    }
  });

  it("reads the site's connectors, and treats errors as none", async () => {
    await expect(
      siteCliConnectors(async () => ({ cliConnectors: ["github", "evil"] })),
    ).resolves.toEqual(["github"]);
    resetSiteCliConnectorsCache();
    await expect(
      siteCliConnectors(async () => {
        throw Error("hub down");
      }),
    ).resolves.toEqual([]);
    await expect(siteCliConnectors(undefined)).resolves.toEqual([]);
  });
});

describe("lease files are never written through a symlink", () => {
  it("refuses to write tokens into a lease directory swapped for a symlink", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "cli-lease-root-"));
    const elsewhere = await fs.mkdtemp(join(tmpdir(), "cli-lease-elsewhere-"));
    try {
      const leaseDir = new BeneathDir(root, ".cocalc-agent-x");
      leaseDir.mkdir();
      await writeCliConnectorTools(leaseDir);
      // The project replaces the lease directory with a symlink elsewhere.
      await fs.rename(join(root, ".cocalc-agent-x"), join(root, "moved"));
      await fs.symlink(elsewhere, join(root, ".cocalc-agent-x"));
      await expect(syncCliConnectorTokens(leaseDir, tokens)).rejects.toThrow();
      await expect(writeCliConnectorTools(leaseDir)).rejects.toThrow();
      expect(await fs.readdir(elsewhere)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("never sweeps through a lease directory swapped for a symlink", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "cli-sweep-root-"));
    const elsewhere = await fs.mkdtemp(join(tmpdir(), "cli-sweep-elsewhere-"));
    try {
      await fs.mkdir(join(elsewhere, "cli"));
      const token = join(elsewhere, "cli", "github-token");
      await fs.writeFile(token, "x");
      const old = new Date(Date.now() - STALE_CLI_TOKEN_MS - 60_000);
      await fs.utimes(token, old, old);
      await fs.symlink(elsewhere, join(root, ".cocalc-agent-other"));
      await expect(
        sweepStaleCliConnectorTokens({
          runtimeDir: new BeneathDir(root),
          ownLeaseName: ".cocalc-agent-own",
        }),
      ).resolves.toBe(0);
      await expect(fs.readFile(token, "utf8")).resolves.toBe("x");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("BeneathDir.writeFile", () => {
  it("writes the whole content, however large", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "beneath-write-"));
    try {
      const big = "x".repeat(4 * 1024 * 1024) + "end";
      new BeneathDir(root).writeFile("big", big);
      expect(await fs.readFile(join(root, "big"), "utf8")).toBe(big);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
