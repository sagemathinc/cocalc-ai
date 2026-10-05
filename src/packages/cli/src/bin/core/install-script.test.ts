import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = process.cwd();
const installer = join(packageRoot, "install.sh");
const packageLinuxRuntime = join(
  packageRoot,
  "sea",
  "package-linux-runtime.sh",
);

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest({
  baseDir,
  artifact,
  version,
}: {
  baseDir: string;
  artifact: string;
  version: string;
}): void {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const manifestDir = join(baseDir, "cocalc");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, `latest-${os}-${arch}.json`),
    `${JSON.stringify({
      url: pathToFileURL(artifact).href,
      sha256: sha256(artifact),
      artifact_id: version,
      version,
      published_at: "2026-07-27T00:00:00.000Z",
      commit: "abcdef123456",
      short: "abcdef12",
    })}\n`,
  );
}

function runInstaller({ dir, baseDir }: { dir: string; baseDir: string }) {
  const home = join(dir, "home");
  const poisonBin = join(dir, "poison-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(poisonBin, { recursive: true });
  writeFileSync(
    join(poisonBin, "xz"),
    "#!/usr/bin/env bash\necho 'xz must not be used' >&2\nexit 97\n",
  );
  chmodSync(join(poisonBin, "xz"), 0o755);
  // stock macOS `curl ... | bash` runs /bin/bash 3.2
  const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
  return spawnSync(bash, [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/bash",
      PATH: `${poisonBin}:${process.env.PATH}`,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      COCALC_CLI_BASE_URL: pathToFileURL(baseDir).href.replace(/\/$/, ""),
    },
  });
}

test(
  "Linux runtime bundle installs without system libatomic or xz",
  { skip: process.platform !== "linux" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-installer-bundle-"));
    const fixtureBinary = join(dir, "fixture-cocalc");
    const fixtureLibatomic = join(dir, "libatomic.so.1");
    const artifact = join(dir, "cocalc-fixture-linux.tar.gz");
    writeFileSync(
      fixtureBinary,
      `#!/usr/bin/env bash
set -Eeuo pipefail
libdir="\${LD_LIBRARY_PATH%%:*}"
test -f "\$libdir/libatomic.so.1" || {
  echo "bundled libatomic is unavailable" >&2
  exit 91
}
echo "fixture-version"
`,
    );
    chmodSync(fixtureBinary, 0o755);
    writeFileSync(fixtureLibatomic, "fixture libatomic\n");

    const packaged = spawnSync(
      "bash",
      [packageLinuxRuntime, fixtureBinary, artifact],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COCALC_CLI_LIBATOMIC_PATH: fixtureLibatomic,
        },
      },
    );
    assert.equal(packaged.status, 0, packaged.stderr);

    const baseDir = join(dir, "software");
    writeManifest({ baseDir, artifact, version: "fixture-version" });
    const installed = runInstaller({ dir, baseDir });
    assert.equal(
      installed.status,
      0,
      `${installed.stdout}\n${installed.stderr}`,
    );
    assert.doesNotMatch(installed.stderr, /xz must not be used/);

    const wrapper = join(dir, "home", ".local", "bin", "cocalc");
    assert.equal(existsSync(wrapper), true);
    const version = spawnSync(wrapper, ["--version"], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "fixture-version");
    assert.equal(
      existsSync(
        join(
          dir,
          "home",
          ".local",
          "share",
          "cocalc",
          "current",
          "lib",
          "libatomic.so.1",
        ),
      ),
      true,
    );
  },
);

test(
  "installer refuses to activate a legacy CLI that cannot start",
  { skip: process.platform !== "linux" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-installer-broken-"));
    const artifact = join(dir, "legacy-cocalc");
    writeFileSync(
      artifact,
      `#!/usr/bin/env bash
echo "error while loading shared libraries: libatomic.so.1: cannot open shared object file" >&2
exit 127
`,
    );
    chmodSync(artifact, 0o755);

    const baseDir = join(dir, "software");
    writeManifest({ baseDir, artifact, version: "broken-version" });
    const installed = runInstaller({ dir, baseDir });
    assert.notEqual(installed.status, 0);
    assert.match(installed.stderr, /could not start/);
    assert.match(installed.stderr, /apt-get install libatomic1/);
    assert.match(installed.stderr, /dnf install libatomic/);
    assert.equal(
      existsSync(join(dir, "home", ".local", "share", "cocalc", "current")),
      false,
    );
  },
);

test(
  "installer retains support for uncompressed macOS-style artifacts",
  {
    skip: !(
      process.platform === "linux" ||
      (process.platform === "darwin" && process.arch === "arm64")
    ),
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-installer-raw-"));
    const artifact = join(dir, "raw-cocalc");
    writeFileSync(artifact, "#!/usr/bin/env bash\necho raw-version\n");
    chmodSync(artifact, 0o755);

    const baseDir = join(dir, "software");
    writeManifest({ baseDir, artifact, version: "raw-version" });
    const installed = runInstaller({ dir, baseDir });
    assert.equal(
      installed.status,
      0,
      `${installed.stdout}\n${installed.stderr}`,
    );

    const wrapper = join(dir, "home", ".local", "bin", "cocalc");
    const version = spawnSync(wrapper, ["--version"], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "raw-version");
  },
);
