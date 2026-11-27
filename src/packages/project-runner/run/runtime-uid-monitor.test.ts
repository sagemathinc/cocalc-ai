import {
  isSideContainerName,
  pastaBinaries,
  stopLeftoverSideContainers,
} from "./runtime-uid-monitor";

const P = "11111111-2222-4333-8444-555555555555";

describe("side containers left from an earlier mode", () => {
  it("names every side launcher's containers, and never a project's", () => {
    for (const name of [
      `acp-${P}-x`,
      `claude-controller-${P}-x`,
      `codex-${P}-abc`,
      `sandbox-${P}-1-ab`,
      "cocalc-rootfs-scan-1",
      `cocalc-browser-${P}`,
    ])
      expect([name, isSideContainerName(name)]).toEqual([name, true]);
    for (const name of [`project-${P}`, "something-else", ""])
      expect([name, isSideContainerName(name)]).toEqual([name, false]);
  });

  it("removes the side containers only, and carries on past a failure", async () => {
    const removed: string[] = [];
    const stopped = await stopLeftoverSideContainers({
      list: async () =>
        [`project-${P}`, `codex-${P}-a`, `acp-${P}-b`, "other"].join("\n"),
      remove: async (name) => {
        if (name.startsWith("codex-")) throw Error("busy");
        removed.push(name);
      },
    });
    expect(removed).toEqual([`acp-${P}-b`]);
    expect(stopped).toEqual([`acp-${P}-b`]);
  });
});

describe("pasta's binaries", () => {
  it("trusts pasta and passt, each build, in the runtime bundle only", () => {
    expect(pastaBinaries("/r")).toEqual([
      "/r/bin/passt",
      "/r/bin/passt.avx2",
      "/r/bin/passt.avx512",
      "/r/bin/pasta",
      "/r/bin/pasta.avx2",
      "/r/bin/pasta.avx512",
    ]);
    expect(pastaBinaries("")).toEqual([]);
  });
});
