const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "bay-cluster.sh");

test("provisions distinct raw bay credentials and a digest-only seed bootstrap", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bay-cluster-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
SCRIPT_PATH="$1"
TEST_TEMP="$2"
source "$SCRIPT_PATH"
trap - EXIT
TEMP_DIR="$TEST_TEMP"
CLUSTER_ID=test-cluster
BAYS=(
  'bay-0=seed.example=10.0.0.1'
  'bay-1=attached.example=10.0.0.2'
)
prepare_bay_credentials
remote_install_command /tmp/topology /tmp/shared /tmp/conat /tmp/credential /tmp/bootstrap > "$TEST_TEMP/install-command"
`,
        "test",
        script,
        temp,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const raw = ["bay-0", "bay-1"].map((bay) =>
      fs.readFileSync(path.join(temp, `${bay}-credential`), "utf8").trim(),
    );
    assert.equal(new Set(raw).size, 2);
    assert.ok(
      raw.every((value) =>
        /^cocalc-bay-v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value),
      ),
    );

    const bootstrap = JSON.parse(
      fs.readFileSync(path.join(temp, "bay-credential-bootstrap.json"), "utf8"),
    );
    assert.deepEqual(
      bootstrap.map(({ bay_id }) => bay_id),
      ["bay-0", "bay-1"],
    );
    bootstrap.forEach(({ secret_digest }, index) => {
      const secret = raw[index].split(".")[2];
      assert.equal(
        secret_digest,
        crypto.createHash("sha256").update(secret).digest("hex"),
      );
      assert.ok(
        !fs
          .readFileSync(
            path.join(temp, "bay-credential-bootstrap.json"),
            "utf8",
          )
          .includes(secret),
      );
    });

    const install = fs.readFileSync(path.join(temp, "install-command"), "utf8");
    assert.match(
      install,
      /install -o cocalc-bay -g cocalc-bay -m 0600 .*bay-credential/,
    );
    assert.match(install, /COCALC_BAY_CREDENTIAL_FILE/);
    assert.match(install, /COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
