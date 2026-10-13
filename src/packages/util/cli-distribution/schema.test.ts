import {
  ACTIVE_LINE_BYTES,
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  SITE_SCHEMA,
  canonicalJson,
  currentPlatform,
  formatActiveLine,
  manifestFiles,
  parseActiveLine,
  parseManifest,
  parsePointer,
  parseSiteInfo,
} from "./schema";

const h = (c: string) => c.repeat(64);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: MANIFEST_SCHEMA,
    release: 1791851943,
    version: "1.0.3",
    git: "056727d54af2167e2ed26506d09233c06a311f42-dirty",
    built_at: "2026-10-13T00:39:03.503Z",
    launcher: { sha256: h("1"), size: 2534 },
    bootstrap: { sha256: h("2"), size: 1200 },
    bundle: { sha256: h("3"), size: 6409619 },
    node: {
      version: "26.11.1",
      platforms: {
        "linux-x64": {
          sha256: h("4"),
          size: 62798625,
          url: "https://nodejs.org/dist/v26.11.1/node-v26.11.1-linux-x64.tar.gz",
          dir: "node-v26.11.1-linux-x64",
          binary: { sha256: h("5"), size: 120000000 },
        },
      },
    },
    ...overrides,
  };
}

const text = (value: unknown) => canonicalJson(value, true);

describe("CLI release manifests", () => {
  it("parses a valid manifest", () => {
    const parsed = parseManifest(text(manifest()));
    expect(parsed.release).toBe(1791851943);
    expect(Object.keys(parsed.node.platforms)).toEqual(["linux-x64"]);
    expect([...manifestFiles(parsed).keys()]).toEqual([
      h("1"),
      h("2"),
      h("3"),
      h("4"),
    ]);
    expect(manifestFiles(parsed).get(h("4"))?.upstream).toMatch(/nodejs.org/);
  });

  it.each([
    ["a wrong schema", { schema: "cocalc-cli-release/2" }],
    ["a non-integer release", { release: 1.5 }],
    ["a bad hash", { bundle: { sha256: "ABC", size: 1 } }],
    ["an oversized bundle", { bundle: { sha256: h("3"), size: 2 ** 30 } }],
    ["a zero size", { launcher: { sha256: h("1"), size: 0 } }],
    ["a bad version", { version: "1.0.3; rm -rf /" }],
    ["no platforms", { node: { version: "26.11.1", platforms: {} } }],
    [
      "a bad archive dir",
      {
        node: {
          version: "26.11.1",
          platforms: {
            "linux-x64": {
              sha256: h("4"),
              size: 1,
              url: "https://x/y",
              dir: "../etc",
            },
          },
        },
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseManifest(text(manifest(overrides)))).toThrow(
      /invalid CLI release data/,
    );
  });

  it.each([
    ["an unknown top-level key", { extra: 1 }],
    ["an unknown file key", { bundle: { sha256: h("3"), size: 1, x: 1 } }],
    [
      "an unknown platform",
      {
        node: {
          version: "26.11.1",
          platforms: { ...manifest().node.platforms, "solaris-sparc": {} },
        },
      },
    ],
  ])("rejects %s (schema /1 is strict)", (_name, overrides) => {
    expect(() => parseManifest(text(manifest(overrides)))).toThrow(/unknown/);
  });

  it("rejects duplicate keys and non-canonical text", () => {
    const good = text(manifest());
    const duplicate = good.replace(
      '"release": 1791851943,',
      '"release": 1,\n  "release": 1791851943,',
    );
    expect(() => JSON.parse(duplicate)).not.toThrow();
    expect(() => parseManifest(duplicate)).toThrow(/canonical/);
    expect(() => parseManifest(JSON.stringify(manifest()))).toThrow(
      /canonical/,
    );
  });

  it("rejects oversized or non-JSON text", () => {
    expect(() => parseManifest("x".repeat(70_000))).toThrow(/too large/);
    expect(() => parseManifest("{")).toThrow(/not JSON/);
  });
});

describe("pointers and site info", () => {
  const pointer = {
    schema: POINTER_SCHEMA,
    release: 10,
    manifest: h("a"),
    min_release: 9,
    published_at: "2026-10-13T00:00:00Z",
  };

  it("parses the store pointer and site info", () => {
    expect(parsePointer(text(pointer)).min_release).toBe(9);
    expect(
      parseSiteInfo(
        JSON.stringify({
          schema: SITE_SCHEMA,
          release: 10,
          manifest: h("a"),
          min_release: null,
        }),
      ).min_release,
    ).toBeNull();
  });

  it("rejects a minimum above the release itself", () => {
    expect(() => parsePointer(text({ ...pointer, min_release: 11 }))).toThrow(
      /min_release/,
    );
  });
});

describe("the active pointer line", () => {
  const active = {
    manifest: h("a"),
    node: h("b"),
    bootstrap: h("c"),
    bundle: h("d"),
  };

  it("round-trips and has the fixed length the launcher checks", () => {
    const line = formatActiveLine(active);
    expect(line.length).toBe(ACTIVE_LINE_BYTES);
    expect(ACTIVE_LINE_BYTES).toBe(263);
    expect(parseActiveLine(line)).toEqual(active);
  });

  it.each([
    ["no newline", (l: string) => l.slice(0, -1)],
    ["an extra byte", (l: string) => l + "x"],
    ["another version", (l: string) => l.replace("v1 ", "v2 ")],
    ["an uppercase hash", (l: string) => l.replace("aaaa", "AAAA")],
    ["two spaces", (l: string) => l.replace(" ", "  ").slice(0, -2) + "\n"],
  ])("rejects %s", (_name, mutate) => {
    expect(() => parseActiveLine(mutate(formatActiveLine(active)))).toThrow();
  });
});

describe("platforms", () => {
  it("maps Node's platform and arch", () => {
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("linux", "x64")).toBe("linux-x64");
    expect(currentPlatform("win32", "x64")).toBeUndefined();
  });
});
