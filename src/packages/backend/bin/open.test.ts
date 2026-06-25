import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "./open";
import {
  COCALC_TERMINAL_OPEN_OSC_ENV,
  makeTerminalOpenOsc,
} from "@cocalc/util/terminal/open-control";

describe("backend/bin/open", () => {
  const originalArgv = process.argv;
  const originalPwd = process.env.PWD;
  const originalControlDir = process.env.COCALC_CONTROL_DIR;
  const originalTerminalOpenOsc = process.env[COCALC_TERMINAL_OPEN_OSC_ENV];

  function restoreEnv(name: string, value: string | undefined): void {
    if (value == null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  afterEach(() => {
    process.argv = originalArgv;
    restoreEnv("PWD", originalPwd);
    restoreEnv("COCALC_CONTROL_DIR", originalControlDir);
    restoreEnv(COCALC_TERMINAL_OPEN_OSC_ENV, originalTerminalOpenOsc);
    jest.restoreAllMocks();
  });

  it("fails instead of creating a missing file", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-open-"));
    const missing = "file-that-does-not-exist.txt";
    process.argv = ["node", "open.ts", missing];
    process.env.PWD = tempDir;
    process.env.COCALC_CONTROL_DIR = tempDir;

    const exit = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as any);
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(main()).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(`open: '${missing}' does not exist`);
    expect(fs.existsSync(path.join(tempDir, missing))).toBe(false);
  });

  it("opens a relative directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-open-"));
    const controlDir = path.join(tempDir, "control");
    const directory = path.join(tempDir, "subdir");
    fs.mkdirSync(directory);
    process.argv = ["node", "open.ts", "subdir"];
    process.env.PWD = tempDir;
    process.env.COCALC_CONTROL_DIR = controlDir;

    await main();

    expect(readOnlySpoolMessage(controlDir)).toEqual({
      event: "open",
      paths: [{ directory }],
    });
  });

  it("opens an absolute directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-open-"));
    const controlDir = path.join(tempDir, "control");
    const directory = path.join(tempDir, "subdir");
    fs.mkdirSync(directory);
    process.argv = ["node", "open.ts", directory];
    process.env.PWD = "/";
    process.env.COCALC_CONTROL_DIR = controlDir;

    await main();

    expect(readOnlySpoolMessage(controlDir)).toEqual({
      event: "open",
      paths: [{ directory }],
    });
  });

  it("emits terminal OSC when enabled", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-open-"));
    const file = path.join(tempDir, "a.txt");
    fs.writeFileSync(file, "test");
    process.argv = ["node", "open.ts", "a.txt"];
    process.env.PWD = tempDir;
    delete process.env.COCALC_CONTROL_DIR;
    process.env[COCALC_TERMINAL_OPEN_OSC_ENV] = "1";
    const writeFile = jest.spyOn(fs, "writeFileSync").mockImplementation(((
      target,
    ) => {
      if (target === "/dev/tty") {
        throw new Error("no tty");
      }
      throw new Error(`unexpected writeFileSync(${String(target)})`);
    }) as typeof fs.writeFileSync);
    const write = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main();

    expect(write).toHaveBeenCalledWith(
      makeTerminalOpenOsc({
        event: "open",
        paths: [{ file }],
      }),
    );
    expect(writeFile).toHaveBeenCalledWith(
      "/dev/tty",
      expect.stringContaining("\x1b]7777;"),
    );
  });
});

function readOnlySpoolMessage(controlDir: string): unknown {
  const files = fs
    .readdirSync(controlDir)
    .filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(controlDir, files[0]), "utf8"));
}
