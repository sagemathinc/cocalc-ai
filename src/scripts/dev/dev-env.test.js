const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseHubStatusInfo,
  resolveHubPassword,
  resolveHubPostgresConnection,
  resolveHubTarget,
} = require("./dev-env.js");

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

test("parseHubStatusInfo extracts postgres connection details from hub status output", () => {
  const statusText = `
running (pid 123)
postgres socket (PGHOST): /tmp/cocalc-postgres/socket
postgres user   (PGUSER): smc
postgres data dir: /tmp/cocalc-postgres/data
`;
  assert.deepEqual(parseHubStatusInfo(statusText), {
    pgHost: "/tmp/cocalc-postgres/socket",
    pgUser: "smc",
    pgDataDir: "/tmp/cocalc-postgres/data",
  });
});

test("resolveHubPostgresConnection prefers status-derived postgres connection details", () => {
  assert.deepEqual(
    resolveHubPostgresConnection({
      pgHost: "/tmp/cocalc-postgres/socket",
      pgUser: "alice",
    }),
    {
      pgHost: "/tmp/cocalc-postgres/socket",
      pgUser: "alice",
      pgDatabase: "smc",
    },
  );
});

test("resolveHubPostgresConnection prefers selected bay local-postgres.env", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cocalc-dev-env-test-"),
  );
  try {
    const selectedDataDir = path.join(root, "bay-1", "postgres");
    const localEnv = path.join(selectedDataDir, "local-postgres.env");
    await fs.promises.mkdir(path.dirname(localEnv), { recursive: true });
    await fs.promises.writeFile(
      localEnv,
      [
        "export PGHOST=/tmp/selected-pg",
        "export PGUSER=bay1",
        "export PGDATABASE=smc",
        "",
      ].join("\n"),
    );

    assert.deepEqual(
      resolveHubPostgresConnection(
        {},
        {
          selectedDataDir,
        },
      ),
      {
        pgHost: "/tmp/selected-pg",
        pgUser: "bay1",
        pgDatabase: "smc",
      },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("resolveHubTarget selects the attached bay from hub daemon env", () => {
  assert.deepEqual(
    resolveHubTarget(
      {
        COCALC_BAY_ID: "bay-0",
        COCALC_CLUSTER_ROLE: "seed",
        COCALC_CLUSTER_SEED_BAY_ID: "bay-0",
        HUB_BIND_HOST: "localhost",
        HUB_PORT: "13004",
        HUB_ENABLE_SECOND_BAY: "1",
        HUB_SECOND_BAY_ID: "bay-1",
        HUB_SECOND_BAY_BIND_HOST: "localhost",
        HUB_SECOND_BAY_PORT: "13114",
        HUB_SECOND_BAY_DATA_DIR: "/tmp/hub-data-bay-1",
      },
      "bay-1",
    ),
    {
      bayId: "bay-1",
      apiUrl: "http://localhost:13114",
      dataDir: "/tmp/hub-data-bay-1/postgres",
      selectedEnv: {
        COCALC_BAY_ID: "bay-1",
        COCALC_CLUSTER_ROLE: "attached",
        COCALC_CLUSTER_SEED_BAY_ID: "bay-0",
        COCALC_CLUSTER_SEED_CONAT_SERVER: "http://localhost:13004",
        COCALC_CLUSTER_SEED_CONAT_PASSWORD: "",
      },
    },
  );
});
