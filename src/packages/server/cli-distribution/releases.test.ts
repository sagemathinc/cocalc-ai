import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  parseManifest,
} from "@cocalc/util/cli-distribution/schema";
import { installScript, shQuote } from "./install-script";
import { CliReleases, NotFound, configuredReleaseSource } from "./releases";

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function store() {
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
          url: "http://127.0.0.1:1/unused",
          dir: "node-v26.11.1-linux-x64",
        },
      },
    },
  };
  const text = JSON.stringify(manifest);
  const hash = sha256(text);
  writeFileSync(join(dir, "manifests", `${hash}.json`), text);
  writeFileSync(
    join(dir, "current.json"),
    JSON.stringify({
      schema: POINTER_SCHEMA,
      release: 42,
      manifest: hash,
      min_release: null,
      published_at: "2026-10-13T00:00:00Z",
    }),
  );
  return { dir, hash, manifest, text, node };
}

describe("CliReleases from a directory", () => {
  it("serves the site info, manifests and listed files", async () => {
    const s = store();
    const releases = new CliReleases(
      { kind: "dir", dir: s.dir },
      { cacheDir: join(s.dir, "cache") },
    );
    expect(await releases.site()).toEqual({
      schema: "cocalc-cli-site/1",
      release: 42,
      manifest: s.hash,
      min_release: null,
    });
    expect((await releases.manifest(s.hash)).text).toBe(s.text);
    const bundle = await releases.file(s.hash, s.manifest.bundle.sha256);
    expect(bundle.size).toBe(6);
  });

  it("refuses unlisted, missing or tampered files", async () => {
    const s = store();
    const releases = new CliReleases(
      { kind: "dir", dir: s.dir },
      { cacheDir: join(s.dir, "cache") },
    );
    await expect(releases.file(s.hash, sha256("other"))).rejects.toThrow(
      NotFound,
    );
    await expect(releases.manifest("0".repeat(64))).rejects.toThrow(NotFound);
    writeFileSync(join(s.dir, "files", s.manifest.launcher.sha256), "LAUNCHER");
    await expect(
      releases.file(s.hash, s.manifest.launcher.sha256),
    ).rejects.toThrow(/wrong hash/);
    // The Node archive isn't in the store and its upstream is unreachable.
    await expect(
      releases.file(s.hash, s.manifest.node.platforms["linux-x64"].sha256),
    ).rejects.toThrow();
  });

  it("refuses a manifest that doesn't hash to its name", async () => {
    const s = store();
    const other = "0".repeat(63) + "1";
    writeFileSync(join(s.dir, "manifests", `${other}.json`), s.text);
    const releases = new CliReleases({ kind: "dir", dir: s.dir });
    await expect(releases.manifest(other)).rejects.toThrow(/does not match/);
  });

  it("refuses a pointer whose manifest is another release", async () => {
    const s = store();
    writeFileSync(
      join(s.dir, "current.json"),
      JSON.stringify({
        schema: POINTER_SCHEMA,
        release: 43,
        manifest: s.hash,
        min_release: null,
        published_at: "x",
      }),
    );
    const releases = new CliReleases({ kind: "dir", dir: s.dir });
    await expect(releases.site()).rejects.toThrow(/release 42/);
  });
});

describe("CliReleases from a URL", () => {
  let server: Server;
  let base = "";
  const s = store();

  beforeAll(async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    server = createServer((req, res) => {
      const path = join(s.dir, `${req.url}`.replace(/^\/cli/, ""));
      if (req.url?.startsWith("/upstream")) {
        res.end(s.node);
      } else if (existsSync(path)) {
        res.end(readFileSync(path));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    base = `http://127.0.0.1:${port}/cli`;
  });
  afterAll(() => server.close());

  it("downloads, verifies and caches files, falling back to the upstream URL", async () => {
    const manifest = parseManifest(s.text);
    // Point the Node archive's upstream at the test server.
    const port = new URL(base).port;
    const text = s.text.replace(
      "http://127.0.0.1:1/unused",
      `http://127.0.0.1:${port}/upstream`,
    );
    const hash = sha256(text);
    writeFileSync(join(s.dir, "manifests", `${hash}.json`), text);
    const releases = new CliReleases(
      { kind: "url", base },
      { cacheDir: join(s.dir, "url-cache") },
    );
    const bundle = await releases.file(hash, manifest.bundle.sha256);
    expect(bundle.path).toBe(join(s.dir, "url-cache", manifest.bundle.sha256));
    const node = await releases.file(
      hash,
      manifest.node.platforms["linux-x64"]!.sha256,
    );
    expect(node.size).toBe(s.node.length);
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
    expect(script).toContain("linux-x64)");
    expect(script).not.toContain("darwin-arm64)");
    // Downloads never follow redirects.
    expect(script).not.toMatch(/curl[^\n]* -[A-Za-z]*L/);
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
