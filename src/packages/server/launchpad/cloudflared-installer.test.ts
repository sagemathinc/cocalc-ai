import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake cloudflared is a text file holding its own --version output.
jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest.fn(async ({ command }: { command: string }) => {
    const { readFile } = jest.requireActual("node:fs/promises");
    try {
      return {
        stdout: await readFile(command, "utf8"),
        stderr: "",
        exit_code: 0,
      };
    } catch {
      return { stdout: "", stderr: "not found", exit_code: 127 };
    }
  }),
}));

import {
  CLOUDFLARED_VERSION,
  ensureLocalCloudflaredBinary,
  getCloudflaredDownloadSpec,
  localCloudflaredBinaryPath,
  parseCloudflaredVersion,
} from "./cloudflared-installer";

const RELEASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

describe("launchpad cloudflared installer", () => {
  test("pins the version for linux x64, with the release checksum", () => {
    expect(CLOUDFLARED_VERSION).toBe("2026.10.3");
    expect(
      getCloudflaredDownloadSpec({ platform: "linux", arch: "x64" }),
    ).toEqual({
      filename: "cloudflared-linux-amd64",
      url: `${RELEASE}/cloudflared-linux-amd64`,
      kind: "binary",
      sha256:
        "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    });
  });

  test("pins the version for linux arm64, with the release checksum", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "linux", arch: "arm64" }),
    ).toEqual({
      filename: "cloudflared-linux-arm64",
      url: `${RELEASE}/cloudflared-linux-arm64`,
      kind: "binary",
      sha256:
        "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    });
  });

  test("maps darwin x64 to the macOS tarball", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "darwin", arch: "x64" }),
    ).toEqual({
      filename: "cloudflared-darwin-amd64.tgz",
      url: `${RELEASE}/cloudflared-darwin-amd64.tgz`,
      kind: "tgz",
    });
  });

  test("returns undefined for unsupported platforms", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "win32", arch: "x64" }),
    ).toBeUndefined();
  });

  test("uses a stable local cache path under the state dir", () => {
    expect(localCloudflaredBinaryPath("/tmp/launchpad-cloudflare")).toBe(
      "/tmp/launchpad-cloudflare/bin/cloudflared",
    );
  });

  test("matches the project-host bootstrap and diagnostics pins", async () => {
    const bootstrap = await readFile(
      join(__dirname, "../cloud/bootstrap/bootstrap.py"),
      "utf8",
    );
    const diagnostics = await readFile(
      join(__dirname, "../../project-host/cloudflared-diagnostics.ts"),
      "utf8",
    );
    expect(bootstrap.match(/^CLOUDFLARED_VERSION = "([^"]+)"/m)?.[1]).toBe(
      CLOUDFLARED_VERSION,
    );
    expect(
      diagnostics.match(/EXPECTED_CLOUDFLARED_VERSION = "([^"]+)"/)?.[1],
    ).toBe(CLOUDFLARED_VERSION);
  });

  test("parses cloudflared --version output", () => {
    expect(
      parseCloudflaredVersion(
        "cloudflared version 2026.10.3 (built 2026-10-21-13:11 UTC)",
      ),
    ).toBe("2026.10.3");
    expect(parseCloudflaredVersion("garbage")).toBeUndefined();
  });
});

describe("ensureLocalCloudflaredBinary", () => {
  const current = `cloudflared version ${CLOUDFLARED_VERSION} (built x)\n`;
  const old = "cloudflared version 2026.6.0 (built x)\n";
  let stateDir: string;
  let fetchMock: jest.Mock;
  const logger = { info: jest.fn(), warn: jest.fn() };

  function specFor(body: string, sha256?: string) {
    return {
      filename: "cloudflared-linux-amd64",
      url: `${RELEASE}/cloudflared-linux-amd64`,
      kind: "binary" as const,
      sha256:
        sha256 ?? createHash("sha256").update(Buffer.from(body)).digest("hex"),
    };
  }

  function serve(body: string) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    });
  }

  async function installed(): Promise<string> {
    return await readFile(localCloudflaredBinaryPath(stateDir), "utf8");
  }

  async function leftovers(): Promise<string[]> {
    return (await readdir(join(stateDir, "bin"))).filter(
      (name) => name !== "cloudflared",
    );
  }

  async function installOld() {
    const path = localCloudflaredBinaryPath(stateDir);
    await mkdir(join(stateDir, "bin"), { recursive: true });
    await writeFile(path, old, { mode: 0o755 });
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "cfd-installer-test-"));
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test("downloads the pinned version when missing", async () => {
    serve(current);
    const path = await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(current),
    });
    expect(path).toBe(localCloudflaredBinaryPath(stateDir));
    expect(fetchMock).toHaveBeenCalledWith(
      `${RELEASE}/cloudflared-linux-amd64`,
      {
        redirect: "follow",
      },
    );
    expect(await installed()).toBe(current);
    expect(await leftovers()).toEqual([]);
  });

  test("keeps an installed binary at the pinned version", async () => {
    serve(current);
    await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(current),
    });
    fetchMock.mockClear();
    await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(current),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("replaces an installed binary at another version", async () => {
    await installOld();
    serve(current);
    await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(current),
    });
    expect(await installed()).toBe(current);
    expect(logger.info).toHaveBeenCalledWith(
      "upgrading cloudflared for launchpad",
      expect.objectContaining({
        installed: "2026.6.0",
        expected: CLOUDFLARED_VERSION,
      }),
    );
    expect(await leftovers()).toEqual([]);
  });

  test("keeps the installed binary when the upgrade download fails", async () => {
    await installOld();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    const path = await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(current),
    });
    expect(path).toBe(localCloudflaredBinaryPath(stateDir));
    expect(await installed()).toBe(old);
    expect(logger.warn).toHaveBeenCalledWith(
      "cloudflared upgrade failed; keeping the installed binary",
      expect.objectContaining({ installed: "2026.6.0" }),
    );
  });

  test("refuses a download whose checksum does not match", async () => {
    serve(current);
    await expect(
      ensureLocalCloudflaredBinary({
        stateDir,
        logger,
        spec: specFor(current, "0".repeat(64)),
      }),
    ).rejects.toThrow("cloudflared checksum mismatch");
    expect(await leftovers()).toEqual([]);
    await expect(installed()).rejects.toThrow();
  });

  test("refuses a download that reports another version", async () => {
    await installOld();
    const other = "cloudflared version 2026.9.0 (built x)\n";
    serve(other);
    await ensureLocalCloudflaredBinary({
      stateDir,
      logger,
      spec: specFor(other),
    });
    expect(await installed()).toBe(old);
    expect(logger.warn).toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });
});
