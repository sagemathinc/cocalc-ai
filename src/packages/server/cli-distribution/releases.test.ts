import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  canonicalJson,
  parseManifest,
} from "@cocalc/util/cli-distribution/schema";
import { installScript, shQuote } from "./install-script";
import {
  CliReleases,
  NotFound,
  type ServableFile,
  configuredReleaseSource,
} from "./releases";

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

async function bytes(file: ServableFile): Promise<string> {
  try {
    return (await file.handle.readFile()).toString("utf8");
  } finally {
    await file.handle.close();
  }
}

function pointerText(release: number, manifest: string): string {
  return canonicalJson(
    {
      schema: POINTER_SCHEMA,
      release,
      manifest,
      min_release: null,
      published_at: "2026-10-13T00:00:00Z",
    },
    true,
  );
}

function store(upstream = "http://127.0.0.1:1/unused") {
  const dir = mkdtempSync(join(tmpdir(), "cli-releases-"));
  mkdirSync(join(dir, "files"));
  mkdirSync(join(dir, "manifests"));
  const file = (data: string) => {
    writeFileSync(join(dir, "files", sha256(data)), data);
    return { sha256: sha256(data), size: Buffer.byteLength(data) };
  };
  const node = "fake node archive";
  const manifest = {
    schema: MANIFEST_SCHEMA,
    release: 42,
    version: "1.0.3",
    git: "abcdef1",
    built_at: "2026-10-13T00:00:00Z",
    launcher: file("launcher"),
    bootstrap: file("bootstrap"),
    bundle: file("bundle"),
    node: {
      version: "26.11.1",
      platforms: {
        "linux-x64": {
          sha256: sha256(node),
          size: node.length,
          url: upstream,
          dir: "node-v26.11.1-linux-x64",
          binary: { sha256: sha256("bin"), size: 3 },
        },
      },
    },
  };
  const text = canonicalJson(manifest, true);
  const hash = sha256(text);
  writeFileSync(join(dir, "manifests", `${hash}.json`), text);
  writeFileSync(join(dir, "current.json"), pointerText(42, hash));
  return { dir, hash, manifest, text, node };
}

function dirReleases(s: ReturnType<typeof store>) {
  return new CliReleases(
    { kind: "dir", dir: s.dir },
    { cacheDir: join(s.dir, "cache") },
  );
}

describe("CliReleases from a directory", () => {
  it("serves the site info, manifests and listed files", async () => {
    const s = store();
    const releases = dirReleases(s);
    expect(await releases.site()).toEqual({
      schema: "cocalc-cli-site/1",
      release: 42,
      manifest: s.hash,
      min_release: null,
    });
    expect((await releases.manifest(s.hash)).text).toBe(s.text);
    const bundle = await releases.file(s.hash, s.manifest.bundle.sha256);
    expect(bundle.size).toBe(6);
    expect(await bytes(bundle)).toBe("bundle");
  });

  it("refuses unlisted, missing or tampered files", async () => {
    const s = store();
    const releases = dirReleases(s);
    await expect(releases.file(s.hash, sha256("other"))).rejects.toThrow(
      NotFound,
    );
    await expect(releases.manifest("0".repeat(64))).rejects.toThrow(NotFound);
    // A same-sized tampered file is caught by its hash.
    writeFileSync(join(s.dir, "files", s.manifest.launcher.sha256), "LAUNCHER");
    await expect(
      releases.file(s.hash, s.manifest.launcher.sha256),
    ).rejects.toThrow();
    // The Node archive isn't in the store and its upstream is unreachable.
    await expect(
      releases.file(s.hash, s.manifest.node.platforms["linux-x64"].sha256),
    ).rejects.toThrow();
  });

  it("re-verifies a file whose bytes changed after it was verified", async () => {
    const s = store();
    const releases = dirReleases(s);
    await bytes(await releases.file(s.hash, s.manifest.bundle.sha256));
    writeFileSync(join(s.dir, "files", s.manifest.bundle.sha256), "BUNDLE");
    await expect(
      releases.file(s.hash, s.manifest.bundle.sha256),
    ).rejects.toThrow();
  });

  it("refuses a manifest that doesn't hash to its name", async () => {
    const s = store();
    const other = "0".repeat(63) + "1";
    writeFileSync(join(s.dir, "manifests", `${other}.json`), s.text);
    await expect(dirReleases(s).manifest(other)).rejects.toThrow(
      /does not match/,
    );
  });

  it("refuses a pointer whose manifest is another release", async () => {
    const s = store();
    writeFileSync(join(s.dir, "current.json"), pointerText(43, s.hash));
    await expect(dirReleases(s).site()).rejects.toThrow(/release 42/);
  });
});

describe("CliReleases from a URL", () => {
  let server: Server;
  let base = "";
  let port = 0;
  let s: ReturnType<typeof store>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = `${req.url}`;
      if (url.startsWith("/upstream")) {
        res.end(s.node);
      } else if (url.startsWith("/moved/")) {
        res.statusCode = 302;
        res.setHeader("Location", url.replace("/moved", "/cli"));
        res.end();
      } else {
        const path = join(s.dir, url.replace(/^\/cli/, ""));
        if (existsSync(path)) {
          res.end(readFileSync(path));
        } else {
          res.statusCode = 404;
          res.end();
        }
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;
    base = `http://127.0.0.1:${port}/cli`;
    s = store(`http://127.0.0.1:${port}/upstream`);
  });
  afterAll(() => server.close());

  it("downloads, verifies and caches files, falling back to the upstream URL", async () => {
    const manifest = parseManifest(s.text);
    const cacheDir = join(s.dir, "url-cache");
    const releases = new CliReleases({ kind: "url", base }, { cacheDir });
    expect(
      await bytes(await releases.file(s.hash, manifest.bundle.sha256)),
    ).toBe("bundle");
    expect(existsSync(join(cacheDir, manifest.bundle.sha256))).toBe(true);
    const node = await releases.file(
      s.hash,
      manifest.node.platforms["linux-x64"]!.sha256,
    );
    expect(await bytes(node)).toBe(s.node);
  });

  it("replaces a tampered cache entry instead of serving it", async () => {
    const manifest = parseManifest(s.text);
    const cacheDir = join(s.dir, "tamper-cache");
    mkdirSync(cacheDir, { mode: 0o700 });
    writeFileSync(join(cacheDir, manifest.bundle.sha256), "BUNDLE");
    const releases = new CliReleases({ kind: "url", base }, { cacheDir });
    expect(
      await bytes(await releases.file(s.hash, manifest.bundle.sha256)),
    ).toBe("bundle");
  });

  it("refuses a cache directory that isn't private", async () => {
    const manifest = parseManifest(s.text);
    const open = join(s.dir, "open-cache");
    mkdirSync(open);
    chmodSync(open, 0o755);
    await expect(
      new CliReleases({ kind: "url", base }, { cacheDir: open }).file(
        s.hash,
        manifest.bundle.sha256,
      ),
    ).rejects.toThrow(/private directory/);
    const link = join(s.dir, "link-cache");
    mkdirSync(join(s.dir, "real-cache"), { mode: 0o700 });
    symlinkSync(join(s.dir, "real-cache"), link);
    await expect(
      new CliReleases({ kind: "url", base }, { cacheDir: link }).file(
        s.hash,
        manifest.bundle.sha256,
      ),
    ).rejects.toThrow(/private directory/);
  });

  it("does not follow redirects from the release store", async () => {
    const releases = new CliReleases({
      kind: "url",
      base: `http://127.0.0.1:${port}/moved`,
    });
    await expect(releases.site()).rejects.toThrow(/redirect/);
  });
});

describe("configuredReleaseSource", () => {
  it("reads COCALC_CLI_RELEASE_SOURCE and defaults to software.cocalc.ai in production", () => {
    expect(
      configuredReleaseSource({ COCALC_CLI_RELEASE_SOURCE: "https://x/y/" }),
    ).toEqual({ kind: "url", base: "https://x/y" });
    expect(
      configuredReleaseSource({ COCALC_CLI_RELEASE_SOURCE: "/srv/cli" }),
    ).toEqual({ kind: "dir", dir: "/srv/cli" });
    expect(
      configuredReleaseSource({
        COCALC_CLI_RELEASE_SOURCE: "off",
        NODE_ENV: "production",
      }),
    ).toBeUndefined();
    expect(configuredReleaseSource({ NODE_ENV: "production" })).toEqual({
      kind: "url",
      base: "https://software.cocalc.ai/software/cli",
    });
  });
});

describe("install.sh", () => {
  const s = store();
  const script = installScript({
    origin: "https://cocalc.ai",
    manifestHash: s.hash,
    manifestSize: s.text.length,
    manifest: parseManifest(s.text),
  });

  it("is valid POSIX sh with every hash embedded", () => {
    execFileSync("sh", ["-n"], { input: script });
    expect(script).toContain(`manifest=${s.hash}`);
    expect(script).toContain(`bundle=${s.manifest.bundle.sha256}`);
    expect(script).toContain(`node_bin_sha=${sha256("bin")}`);
    expect(script).toContain("linux-x64)");
    expect(script).not.toContain("darwin-arm64)");
    // Downloads never follow redirects.
    expect(script).not.toMatch(/curl[^\n]* -[A-Za-z]*L/);
  });

  it("accepts glibc with musl also installed; names missing libraries", () => {
    // Refuse musl only when glibc is absent (getconf), not because
    // /lib/ld-musl-* exists.
    expect(script).toContain("! getconf GNU_LIBC_VERSION");
    if (process.platform !== "linux" || process.arch !== "x64") return;
    // A pinned Node already in place (so nothing is downloaded) that can't
    // start, and an ldd that reports libatomic missing, as in ubuntu:24.04.
    const home = mkdtempSync(join(tmpdir(), "cli-install-"));
    const nodeDir = join(
      home,
      ".local/share/cocalc/cli/node",
      s.manifest.node.platforms["linux-x64"].sha256,
      "bin",
    );
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "node"), "bin");
    chmodSync(join(nodeDir, "node"), 0o700);
    const fakeBin = join(home, "fake-bin");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "ldd"),
      "#!/bin/sh\necho '\tlibatomic.so.1 => not found'\necho '\tlibc.so.6 => /lib/libc.so.6'\n",
    );
    chmodSync(join(fakeBin, "ldd"), 0o755);
    let stderr = "";
    try {
      execFileSync("sh", [], {
        input: script,
        env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      stderr = `${err.stderr}`;
    }
    expect(stderr).toContain(
      "Node needs system libraries that are missing: libatomic.so.1",
    );
    expect(stderr).toContain("sudo apt-get install libatomic1");
  });

  it("refuses an origin that could break out of quoting", () => {
    expect(() =>
      installScript({
        origin: "https://x'; rm -rf ~; '",
        manifestHash: s.hash,
        manifestSize: 1,
        manifest: parseManifest(s.text),
      }),
    ).toThrow(/unusable origin/);
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
});
