import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCliConnectorEnv,
  syncCliConnectorTokens,
  writeCliConnectorTools,
} from "./cli-connector-files";

let dir: string;
let realBin: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "cli-connector-files-"));
  realBin = join(dir, "real-bin");
  await fs.mkdir(realBin);
  // Stand-ins for the real commands: print the token they were given.
  await fs.writeFile(
    join(realBin, "gh"),
    '#!/bin/sh\necho "gh:${GH_TOKEN-unset}:$*"\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    join(realBin, "cf"),
    '#!/bin/sh\necho "cf:${CLOUDFLARE_API_TOKEN-unset}"\n',
    { mode: 0o755 },
  );
  await writeCliConnectorTools(dir);
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

it("puts the wrappers first on PATH and appends the git helper", () => {
  const e: Record<string, string> = {
    PATH: "/usr/bin",
    GIT_CONFIG_COUNT: "2",
  };
  applyCliConnectorEnv(e, "/c");
  expect(e.PATH).toBe("/c/cli/bin:/usr/bin");
  expect(e.GIT_CONFIG_COUNT).toBe("3");
  expect(e.GIT_CONFIG_KEY_2).toBe("credential.https://github.com.helper");
  expect(e.GIT_CONFIG_VALUE_2).toBe("/c/cli/bin/git-credential-cocalc");
  applyCliConnectorEnv(e, "/c");
  expect(e.PATH).toBe("/c/cli/bin:/usr/bin");
});

it("runs the real command unchanged when no connector is on", () => {
  expect(run("gh", ["pr", "list"]).trim()).toBe("gh:unset:pr list");
  expect(run("cf").trim()).toBe("cf:unset");
});

it("supplies the tokens during a turn and removes them after", async () => {
  await syncCliConnectorTokens(dir, tokens);
  expect(run("gh", ["api", "user"]).trim()).toBe("gh:gho_test:api user");
  expect(run("cf").trim()).toBe("cf:cf_test");
  const stat = await fs.stat(join(dir, "cli", "github-token"));
  expect(stat.mode & 0o777).toBe(0o600);

  await syncCliConnectorTokens(dir, [tokens[1]]);
  expect(run("gh").trim()).toBe("gh:unset:");
  expect(run("cf").trim()).toBe("cf:cf_test");

  await syncCliConnectorTokens(dir, []);
  expect(run("cf").trim()).toBe("cf:unset");
  expect(await fs.readdir(join(dir, "cli"))).toEqual(["bin"]);
});

it("ignores malformed tokens", async () => {
  await syncCliConnectorTokens(dir, [{ ...tokens[0], token: "a b" }]);
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

describe("git credential helper", () => {
  const helper = () => join(dir, "cli", "bin", "git-credential-cocalc");

  it("answers only for https://github.com, and only during a turn", async () => {
    const ask = (host: string, protocol = "https") =>
      run(helper(), ["get"], `protocol=${protocol}\nhost=${host}\n\n`);
    expect(ask("github.com")).toBe("");
    await syncCliConnectorTokens(dir, tokens);
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

  it("is used by git itself", async () => {
    await syncCliConnectorTokens(dir, tokens);
    const out = run(
      "git",
      ["credential", "fill"],
      "protocol=https\nhost=github.com\n\n",
    );
    expect(out).toContain("password=gho_test");
  });
});
