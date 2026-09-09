import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesBinarySha256 } from "./binary-integrity";

describe("binary content identity", () => {
  let dir: string;
  const digest = (data: string | Buffer) =>
    createHash("sha256").update(data).digest("hex");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cocalc-binary-integrity-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches the full contents across multiple stream chunks", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 42);
    const path = join(dir, "codex");
    await writeFile(path, data);
    expect(await matchesBinarySha256(path, digest(data))).toBe(true);
  });

  it("rejects a same-version stock replacement and does not cache identity", async () => {
    const path = join(dir, "codex");
    const patched = "codex-cli 0.153.4 patched";
    await writeFile(path, patched);
    expect(await matchesBinarySha256(path, digest(patched))).toBe(true);
    await writeFile(path, "codex-cli 0.153.4 stock");
    expect(await matchesBinarySha256(path, digest(patched))).toBe(false);
  });

  it("fails closed on missing files, directories, and invalid pins", async () => {
    expect(await matchesBinarySha256(join(dir, "missing"), digest(""))).toBe(
      false,
    );
    expect(await matchesBinarySha256(dir, digest(""))).toBe(false);
    expect(await matchesBinarySha256(dir, "")).toBe(false);
  });
});
