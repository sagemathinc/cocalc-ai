import dust, { resolveDustCommandPath } from "./dust";
import { dust as dustBin } from "./install";
import { existsSync } from "node:fs";
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

const describeDust =
  process.platform === "linux" && existsSync(dustBin)
    ? describe
    : describe.skip;

describe("resolveDustCommandPath", () => {
  it("uses the configured dust binary when it exists", () => {
    expect(resolveDustCommandPath((path) => path === dustBin)).toBe(dustBin);
  });

  it("falls back to the project runtime dust binary when the configured binary is stale", () => {
    expect(
      resolveDustCommandPath((path) => path === "/opt/cocalc/bin2/dust"),
    ).toBe("/opt/cocalc/bin2/dust");
  });

  it("returns the configured path when no fallback exists so the spawn error stays explicit", () => {
    expect(resolveDustCommandPath(() => false)).toBe(dustBin);
  });
});

describeDust("dust works", () => {
  it("directory starts empty - no results", async () => {
    const { stdout, truncated } = await dust(tempDir, { options: ["-j"] });
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s).toEqual({ children: [], name: tempDir, size: s.size });
    expect(truncated).toBe(false);
  });

  it("create a file and see it appears in the dust result", async () => {
    await writeFile(join(tempDir, "a.txt"), "hello");
    const { stdout, truncated } = await dust(tempDir, { options: ["-j"] });
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s).toEqual({
      size: s.size,
      name: tempDir,
      children: [
        {
          size: s.children[0].size,
          name: join(tempDir, "a.txt"),
          children: [],
        },
      ],
    });
    expect(truncated).toBe(false);
  });
});
