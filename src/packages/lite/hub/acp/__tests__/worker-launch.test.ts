import { resolveLiteAcpWorkerLaunch } from "../worker-launch";

describe("resolveLiteAcpWorkerLaunch", () => {
  it("uses the current script when running under node", () => {
    expect(
      resolveLiteAcpWorkerLaunch({
        command: "/opt/homebrew/bin/node",
        entryPoint: "/tmp/cocalc-plus/index.js",
      }),
    ).toEqual({
      command: "/opt/homebrew/bin/node",
      args: ["/tmp/cocalc-plus/index.js"],
    });
  });

  it("respawns the SEA binary directly when not running under node", () => {
    expect(
      resolveLiteAcpWorkerLaunch({
        command: "/Applications/CoCalc Plus.app/Contents/MacOS/cocalc-plus",
        entryPoint: "/tmp/extracted/bundle/index.js",
      }),
    ).toEqual({
      command: "/Applications/CoCalc Plus.app/Contents/MacOS/cocalc-plus",
      args: [],
    });
  });

  it("rejects node launches when the entrypoint is missing", () => {
    expect(() =>
      resolveLiteAcpWorkerLaunch({
        command: "/usr/local/bin/node",
        entryPoint: "",
      }),
    ).toThrow("unable to resolve lite ACP worker entrypoint");
  });
});
