/*
Test the exec command.
*/

import exec, {
  parseAndValidateOptions,
  parseOutput,
  selectPlatformOptions,
  validate,
} from "./exec";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("exec bounded process lifetime", () => {
  const posixTest = process.platform === "win32" ? it.skip : it;

  posixTest(
    "escalates when SIGTERM is ignored",
    async () => {
      const output = await exec({
        cmd: process.execPath,
        prefixArgs: [
          "-e",
          `
        process.on('SIGTERM', () => {});
        console.log('ready');
        setTimeout(() => process.exit(99), 10000);
      `,
        ],
        killProcessGroup: true,
        timeout: 1000,
      });
      expect(output.stdout.toString()).toContain("ready");
      expect(output.truncated).toBe(true);
      expect(output.code).not.toBe(0);
      expect(() => parseOutput(output)).toThrow();
    },
    15000,
  );

  posixTest(
    "kills pipe-holding descendants even after the leader exits",
    async () => {
      let descendant = 0;
      const childScript = `
      process.on('SIGTERM', () => {});
      console.log(process.pid);
      setTimeout(() => process.exit(99), 10000);
    `;
      const output = await exec({
        cmd: process.execPath,
        prefixArgs: [
          "-e",
          `
        require('node:child_process').spawn(process.execPath,
          ['-e', ${JSON.stringify(childScript)}], {stdio: 'inherit'});
      `,
        ],
        onStdoutLine: (line) => {
          descendant = Number(line);
        },
        killProcessGroup: true,
        timeout: 1000,
      });
      expect(descendant).toBeGreaterThan(0);
      expect(output.truncated).toBe(true);
      expect(output.code).not.toBe(0);
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${descendant}/stat`, "utf8").catch(
          (err) => {
            if (err.code === "ENOENT") return "";
            throw err;
          },
        );
        // An adopted child may briefly await init's reap, but must not be running.
        expect(status === "" || /\) Z /.test(status)).toBe(true);
      }
    },
    15000,
  );

  posixTest(
    "output overflow escalates even with timeout disabled",
    async () => {
      const output = await exec({
        cmd: process.execPath,
        prefixArgs: [
          "-e",
          `
        process.on('SIGTERM', () => {});
        setInterval(() => process.stdout.write('x'.repeat(4096)), 10);
        setTimeout(() => process.exit(99), 10000);
      `,
        ],
        killProcessGroup: true,
        timeout: 0,
        maxSize: 128,
      });
      expect(output.truncated).toBe(true);
      expect(output.code).not.toBe(0);
      expect(output.stdout.length).toBeLessThanOrEqual(128);
    },
    15000,
  );

  it("rejects spawn errors without waiting for a timeout", async () => {
    await expect(
      exec({ cmd: join(tempDir, "does-not-exist") }),
    ).rejects.toThrow();
  });

  it.each([null, 1, 99])("does not parse exit code %s as success", (code) => {
    expect(() =>
      parseOutput({
        stdout: Buffer.from("looks successful"),
        stderr: Buffer.alloc(0),
        code,
        truncated: false,
      }),
    ).toThrow();
  });

  it("does not parse truncated output with exit zero as success", () => {
    expect(() =>
      parseOutput({
        stdout: Buffer.from("{}"),
        stderr: Buffer.alloc(0),
        code: 0,
        truncated: true,
      }),
    ).toThrow("limit");
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
