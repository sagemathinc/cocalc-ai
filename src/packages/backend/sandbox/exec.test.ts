/*
Test the exec command.
*/

import exec, { parseAndValidateOptions, selectPlatformOptions, validate } from "./exec";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir;
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cocalc"));
});
afterAll(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("exec works", () => {
  it(`create file and run ls command`, async () => {
    await writeFile(join(tempDir, "a.txt"), "hello");
    const { stderr, stdout, truncated, code } = await exec({
      cmd: "ls",
      cwd: tempDir,
    });
    expect(code).toBe(0);
    expect(truncated).toBe(false);
    expect(stdout.toString()).toEqual("a.txt\n");
    expect(stderr.toString()).toEqual("");
  });
});

describe("exec option validation", () => {
  it("int validation requires whole-number strings", () => {
    expect(() =>
      parseAndValidateOptions(["--count", "12abc"], {
        "--count": validate.int,
      }),
    ).toThrow("integer");
    expect(() =>
      parseAndValidateOptions(["--count", "12"], {
        "--count": validate.int,
      }),
    ).not.toThrow();
  });

  it("float validation rejects trailing garbage", () => {
    expect(() =>
      parseAndValidateOptions(["--ratio", "1.5x"], {
        "--ratio": validate.float,
      }),
    ).toThrow("number");
    expect(() =>
      parseAndValidateOptions(["--ratio", "1.5"], {
        "--ratio": validate.float,
      }),
    ).not.toThrow();
  });

  it("relativePath validation blocks absolute and parent paths", () => {
    expect(() =>
      parseAndValidateOptions(["--file", "/tmp/x"], {
        "--file": validate.relativePath,
      }),
    ).toThrow("relative");
    expect(() =>
      parseAndValidateOptions(["--file", "../x"], {
        "--file": validate.relativePath,
      }),
    ).toThrow("within working directory");
    expect(() =>
      parseAndValidateOptions(["--file", "sub/x"], {
        "--file": validate.relativePath,
      }),
    ).not.toThrow();
  });
});

describe("exec platform option selection", () => {
  it("adds linux options only on linux", () => {
    expect(
      selectPlatformOptions(["--base"], {
        linux: ["--linux"],
        darwin: ["--darwin"],
        platformName: "linux",
      }),
    ).toEqual(["--base", "--linux"]);
  });

  it("adds darwin options only on darwin", () => {
    expect(
      selectPlatformOptions(["--base"], {
        linux: ["--linux"],
        darwin: ["--darwin"],
        platformName: "darwin",
      }),
    ).toEqual(["--base", "--darwin"]);
  });
});
