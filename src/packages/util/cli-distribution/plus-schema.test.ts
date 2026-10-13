import { PLUS_MANIFEST_SCHEMA, parsePlusManifest } from "./plus-schema";
import { canonicalJson } from "./schema";

const h = (c: string) => c.repeat(64);
const ref = (c: string, size = 100) => ({ sha256: h(c), size });

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: PLUS_MANIFEST_SCHEMA,
    release: 1791860000,
    version: "1.0.3",
    git: "abcdef1",
    built_at: "2026-10-13T00:00:00Z",
    launcher: ref("1"),
    bootstrap: ref("2"),
    node: {
      version: "26.11.1",
      platforms: {
        "darwin-arm64": {
          ...ref("3"),
          url: "https://nodejs.org/dist/v26.11.1/node-v26.11.1-darwin-arm64.tar.gz",
          dir: "node-v26.11.1-darwin-arm64",
          binary: ref("4"),
        },
      },
    },
    app: { "darwin-arm64": ref("5") },
    tools: { "darwin-arm64": ref("6") },
    static: ref("7"),
    public: ref("8"),
    ...overrides,
  };
}

const text = (value: unknown) => canonicalJson(value, true);

describe("CoCalc Plus release manifests", () => {
  it("parses a valid manifest", () => {
    const parsed = parsePlusManifest(text(manifest()));
    expect(parsed.app["darwin-arm64"]?.sha256).toBe(h("5"));
    expect(parsed.static.sha256).toBe(h("7"));
  });

  it.each([
    [
      "an app without Node for its platform",
      { app: { "linux-x64": ref("5") } },
    ],
    ["no app at all", { app: {} }],
    ["an unknown platform", { tools: { "solaris-sparc": ref("6") } }],
    ["an unknown key", { extra: 1 }],
    ["a CLI schema", { schema: "cocalc-cli-release/1" }],
    ["a missing static part", { static: undefined }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parsePlusManifest(text(manifest(overrides)))).toThrow(
      /invalid CLI release data/,
    );
  });

  it("requires canonical text", () => {
    expect(() => parsePlusManifest(JSON.stringify(manifest()))).toThrow(
      /canonical/,
    );
  });
});
