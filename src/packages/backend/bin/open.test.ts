import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "./open";

describe("backend/bin/open", () => {
  const originalArgv = process.argv;
  const originalPwd = process.env.PWD;
  const originalControlDir = process.env.COCALC_CONTROL_DIR;

  afterEach(() => {
    process.argv = originalArgv;
    process.env.PWD = originalPwd;
    process.env.COCALC_CONTROL_DIR = originalControlDir;
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
});

function readOnlySpoolMessage(controlDir: string): unknown {
  const files = fs
    .readdirSync(controlDir)
    .filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(controlDir, files[0]), "utf8"));
}
