import { strFromU8, unzipSync } from "fflate";
import { bundleToZipBytes } from "./zip";

describe("@cocalc/export zip", () => {
  it("writes manifest, files, and assets into one zip bundle", () => {
    const zip = bundleToZipBytes({
      manifest: {
        format: "cocalc-export",
        version: 1,
        kind: "chat",
        exported_at: "2026-03-06T12:00:00.000Z",
      },
      files: [
        {
          path: "threads/index.json",
          content: '{"threads":[]}\n',
        },
      ],
      assets: [
        {
          originalRef: "/blobs/example",
          path: "assets/example.txt",
          sha256: "abc",
          content: new TextEncoder().encode("hello\n"),
        },
      ],
    });
    const unzipped = unzipSync(zip);
    expect(strFromU8(unzipped["manifest.json"])).toContain('"kind": "chat"');
    expect(strFromU8(unzipped["threads/index.json"])).toBe('{"threads":[]}\n');
    expect(strFromU8(unzipped["assets/example.txt"])).toBe("hello\n");
  });

  it("rejects duplicate bundle paths", () => {
    expect(() =>
      bundleToZipBytes({
        manifest: {
          format: "cocalc-export",
          version: 1,
          kind: "chat",
          exported_at: "2026-03-06T12:00:00.000Z",
        },
        files: [
          { path: "x.txt", content: "a" },
          { path: "x.txt", content: "b" },
        ],
      }),
    ).toThrow("duplicate export path");
  });

  it("writes bundles under the configured root directory", () => {
    const zip = bundleToZipBytes({
      rootDir: "sample-chat",
      manifest: {
        format: "cocalc-export",
        version: 1,
        kind: "chat",
        exported_at: "2026-03-06T12:00:00.000Z",
      },
      files: [
        {
          path: "threads/index.json",
          content: '{"threads":[]}\n',
        },
      ],
    });
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped).sort()).toEqual([
      "sample-chat/manifest.json",
      "sample-chat/threads/index.json",
    ]);
  });
});
