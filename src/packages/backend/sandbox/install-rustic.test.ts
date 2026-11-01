import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe.each(["x64", "arm64"])("pinned rustic install (%s)", (arch) => {
  const original = { ...process.env };
  let dir: string;
  beforeEach(() => {
    jest.resetModules();
    dir = mkdtempSync(join(tmpdir(), "rustic-install-"));
    process.env.COCALC_TOOL_ARCH = arch;
    process.env.COCALC_BIN_PATH = join(dir, "bin");
  });
  afterEach(() => {
    process.env = { ...original };
    rmSync(dir, { recursive: true, force: true });
  });

  // A local archive served by a fake curl, so the script runs offline.
  function fixture() {
    const src = join(dir, "src");
    execFileSync("mkdir", ["-p", src, join(dir, "fakebin")]);
    const binary = join(src, "rustic");
    writeFileSync(binary, "#!/bin/sh\necho rustic 0.11.4-cocalc.3\n");
    chmodSync(binary, 0o755);
    const archive = join(dir, "rustic.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "rustic"]);
    const curl = join(dir, "fakebin", "curl");
    writeFileSync(
      curl,
      `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "${archive}" "$2"\n`,
    );
    chmodSync(curl, 0o755);
    return { archive: sha256(archive), binary: sha256(binary) };
  }

  function run(script: string) {
    return spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${join(dir, "fakebin")}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
  }

  it("pins the release URL and both hashes, and checks before installing", () => {
    const { SPEC } = require("./install");
    const script: string = SPEC.rustic.script();
    const releaseArch = arch === "x64" ? "x86_64" : "arm64";
    expect(SPEC.rustic.VERSION).toBe("0.11.4-cocalc.3");
    expect(script).toContain(
      `https://github.com/sagemathinc/rustic/releases/download/v0.11.4-cocalc.3/rustic-v0.11.4-cocalc.3-linux-${releaseArch}.tar.gz`,
    );
    const archiveCheck = script.indexOf("sha256sum -c -");
    const extract = script.indexOf("tar -xzf");
    const binaryCheck = script.indexOf("sha256sum -c -", archiveCheck + 1);
    const install = script.indexOf("install -m 0755");
    expect(archiveCheck).toBeGreaterThan(-1);
    expect(archiveCheck).toBeLessThan(extract);
    expect(extract).toBeLessThan(binaryCheck);
    expect(binaryCheck).toBeLessThan(install);
  });

  it("installs when the archive and the binary match", () => {
    const { getRusticInstallScript, SPEC } = require("./install");
    const result = run(getRusticInstallScript(fixture()));
    expect(result.status).toBe(0);
    expect(existsSync(SPEC.rustic.path)).toBe(true);
  });

  it("refuses an archive with the wrong hash and installs nothing", () => {
    const { getRusticInstallScript, SPEC } = require("./install");
    const good = fixture();
    const result = run(
      getRusticInstallScript({ ...good, archive: "0".repeat(64) }),
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(SPEC.rustic.path)).toBe(false);
  });

  it("refuses a binary with the wrong hash even if the archive matches", () => {
    const { getRusticInstallScript, SPEC } = require("./install");
    const good = fixture();
    const result = run(
      getRusticInstallScript({ ...good, binary: "0".repeat(64) }),
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(SPEC.rustic.path)).toBe(false);
  });

  it("does not trust an installed rustic whose binary hash differs", async () => {
    const { SPEC, alreadyInstalled } = require("./install");
    execFileSync("mkdir", ["-p", join(dir, "bin")]);
    // Same version string as the pinned release, but not the pinned binary.
    writeFileSync(SPEC.rustic.path, "#!/bin/sh\necho rustic 0.11.4-cocalc.3\n");
    chmodSync(SPEC.rustic.path, 0o755);
    expect(await alreadyInstalled("rustic")).toBe(false);
  });
});
