import {
  getCloudflaredDownloadSpec,
  localCloudflaredBinaryPath,
} from "./cloudflared-installer";

describe("launchpad cloudflared installer", () => {
  test("maps linux x64 to the amd64 release binary", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "linux", arch: "x64" }),
    ).toEqual({
      filename: "cloudflared-linux-amd64",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
      kind: "binary",
    });
  });

  test("maps linux arm64 to the arm64 release binary", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "linux", arch: "arm64" }),
    ).toEqual({
      filename: "cloudflared-linux-arm64",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
      kind: "binary",
    });
  });

  test("maps darwin x64 to the macOS tarball", () => {
    expect(
      getCloudflaredDownloadSpec({ platform: "darwin", arch: "x64" }),
    ).toEqual({
      filename: "cloudflared-darwin-amd64.tgz",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
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
});
