const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveHubPassword } = require("./dev-env.js");

test("resolveHubPassword prefers the active postgres data-dir secret over legacy data secrets", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cocalc-dev-env-test-"),
  );
  try {
    const legacySecret = path.join(root, "data", "secrets", "conat-password");
    const activePgDataDir = path.join(root, "alt", "postgres", "main");
    const activeSecret = path.join(
      root,
      "alt",
      "postgres",
      "secrets",
      "conat-password",
    );

    await fs.promises.mkdir(path.dirname(legacySecret), { recursive: true });
    await fs.promises.writeFile(legacySecret, "stale");
    await fs.promises.mkdir(path.dirname(activeSecret), { recursive: true });
    await fs.promises.mkdir(activePgDataDir, { recursive: true });
    await fs.promises.writeFile(activeSecret, "correct");

    assert.equal(
      resolveHubPassword(
        {
          pgDataDir: activePgDataDir,
        },
        { root },
      ),
      activeSecret,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
