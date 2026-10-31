import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rootArtifactsSecured,
  startRootArtifactSecuring,
  readRootArtifactConfig,
  rootArtifactLayout,
  rootInstallArtifact,
  rootPruneArtifact,
  rootSetCurrentArtifact,
  setRunHelperForTests,
} from "./artifact-install";

describe("root artifact installs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artifact-install-"));
  });
  afterEach(async () => {
    setRunHelperForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("are used only where bootstrap installed the helper and its configuration", async () => {
    const configPath = join(dir, "software-source.json");
    const helperPath = join(dir, "cocalc-runtime-artifacts");
    await writeFile(
      configPath,
      JSON.stringify({
        bases: ["https://software.example.invalid/software"],
        artifacts: {
          tools: {
            root: "/opt/cocalc/tools",
            current: "/opt/cocalc/tools/current",
          },
        },
      }),
    );
    // no helper: not used
    expect(
      await readRootArtifactConfig({ configPath, helperPath }),
    ).toBeUndefined();
    await writeFile(helperPath, "#!/usr/bin/python3\n");
    expect(
      await rootArtifactLayout("tools", { configPath, helperPath }),
    ).toEqual({
      root: "/opt/cocalc/tools",
      current: "/opt/cocalc/tools/current",
    });
    // a kind root doesn't install here
    expect(
      await rootArtifactLayout("project-host", { configPath, helperPath }),
    ).toBeUndefined();
    await writeFile(configPath, "{");
    expect(
      await readRootArtifactConfig({ configPath, helperPath }),
    ).toBeUndefined();
  });

  it("pass exactly the kind, version and base to the helper", async () => {
    const calls: string[][] = [];
    setRunHelperForTests(async (args) => {
      calls.push(args);
      return '{"status": "installed"}\n';
    });
    expect(
      await rootInstallArtifact(
        "tools",
        "20261030T071949Z-dcbf6646",
        "https://software.example.invalid/software/",
      ),
    ).toBe("installed");
    await rootSetCurrentArtifact("tools", "20261030T071949Z-dcbf6646");
    await rootSetCurrentArtifact("tools", "20261029T000000Z-aaaa", {
      link: "previous",
    });
    expect(calls).toEqual([
      [
        "install-artifact",
        "tools",
        "20261030T071949Z-dcbf6646",
        "--base",
        "https://software.example.invalid/software",
      ],
      ["set-current-artifact", "tools", "20261030T071949Z-dcbf6646"],
      [
        "set-current-artifact",
        "tools",
        "20261029T000000Z-aaaa",
        "--link",
        "previous",
      ],
    ]);
  });

  it("secure the program directories at start, retrying a failure", async () => {
    const configPath = join(dir, "software-source.json");
    const helperPath = join(dir, "cocalc-runtime-artifacts");
    await writeFile(
      configPath,
      JSON.stringify({
        bases: [],
        artifacts: {
          tools: {
            root: "/opt/cocalc/tools",
            current: "/opt/cocalc/tools/current",
          },
        },
      }),
    );
    await writeFile(helperPath, "#!/usr/bin/python3\n");
    const calls: string[][] = [];
    let fail = true;
    setRunHelperForTests(async (args) => {
      calls.push(args);
      if (fail) throw new Error("secure-artifacts failed: offline");
      return '{"status": "ok", "reinstalled": {}, "errors": {}}';
    });
    const stop = await startRootArtifactSecuring({
      baseUrl: "https://software.example.invalid/software/",
      retryMs: 20,
      paths: { configPath, helperPath },
    });
    // the first attempt is awaited before start returns
    expect(calls).toEqual([
      [
        "secure-artifacts",
        "--base",
        "https://software.example.invalid/software",
      ],
    ]);
    expect(rootArtifactsSecured().secured).toBe(false);
    fail = false;
    for (let i = 0; i < 100 && !rootArtifactsSecured().secured; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toHaveLength(2);
    expect(rootArtifactsSecured().secured).toBe(true);
    stop();
  });

  it("have nothing to secure on hosts without root installs", async () => {
    const calls: string[][] = [];
    setRunHelperForTests(async (args) => {
      calls.push(args);
      return "{}";
    });
    const stop = await startRootArtifactSecuring({
      baseUrl: "https://software.example.invalid/software",
      paths: {
        configPath: join(dir, "absent.json"),
        helperPath: join(dir, "absent"),
      },
    });
    expect(calls).toEqual([]);
    expect(rootArtifactsSecured().secured).toBe(true);
    stop();
  });

  it("treat a prune root refuses (current or in use) as kept", async () => {
    setRunHelperForTests(async () => {
      throw new Error("prune-artifact failed: /opt/cocalc/tools/v1 is in use");
    });
    expect(await rootPruneArtifact("tools", "v1")).toBe("kept");
    setRunHelperForTests(async () => '{"status": "absent"}');
    expect(await rootPruneArtifact("tools", "v1")).toBe("absent");
    setRunHelperForTests(async () => '{"status": "removed"}');
    expect(await rootPruneArtifact("tools", "v1")).toBe("removed");
  });
});
