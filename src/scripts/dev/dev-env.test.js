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

test("resolveHubTarget selects an arbitrary bay from normalized cluster env", () => {
  assert.deepEqual(
    resolveHubTarget(
      {
        HUB_CLUSTER_BAY_COUNT: "3",
        HUB_CLUSTER_PRIMARY_BAY_ID: "bay-0",
        HUB_CLUSTER_BAY_0_ID: "bay-0",
        HUB_CLUSTER_BAY_0_ROLE: "seed",
        HUB_CLUSTER_BAY_0_IS_PRIMARY: "1",
        HUB_CLUSTER_BAY_0_BIND_HOST: "localhost",
        HUB_CLUSTER_BAY_0_PORT: "13004",
        HUB_CLUSTER_BAY_0_DATA_DIR: "",
        HUB_CLUSTER_BAY_0_SEED_BAY_ID: "bay-0",
        HUB_CLUSTER_BAY_0_SEED_CONAT_SERVER: "",
        HUB_CLUSTER_BAY_0_SEED_CONAT_PASSWORD: "",
        HUB_CLUSTER_BAY_1_ID: "bay-1",
        HUB_CLUSTER_BAY_1_ROLE: "attached",
        HUB_CLUSTER_BAY_1_IS_PRIMARY: "0",
        HUB_CLUSTER_BAY_1_BIND_HOST: "localhost",
        HUB_CLUSTER_BAY_1_PORT: "13114",
        HUB_CLUSTER_BAY_1_DATA_DIR: "/tmp/hub-data-bay-1",
        HUB_CLUSTER_BAY_1_SEED_BAY_ID: "bay-0",
        HUB_CLUSTER_BAY_1_SEED_CONAT_SERVER: "http://localhost:13004",
        HUB_CLUSTER_BAY_1_SEED_CONAT_PASSWORD: "",
        HUB_CLUSTER_BAY_2_ID: "bay-2",
        HUB_CLUSTER_BAY_2_ROLE: "attached",
        HUB_CLUSTER_BAY_2_IS_PRIMARY: "0",
        HUB_CLUSTER_BAY_2_BIND_HOST: "localhost",
        HUB_CLUSTER_BAY_2_PORT: "13214",
        HUB_CLUSTER_BAY_2_DATA_DIR: "/tmp/hub-data-bay-2",
        HUB_CLUSTER_BAY_2_SEED_BAY_ID: "bay-0",
        HUB_CLUSTER_BAY_2_SEED_CONAT_SERVER: "http://localhost:13004",
        HUB_CLUSTER_BAY_2_SEED_CONAT_PASSWORD: "",
      },
      "bay-2",
    ),
    {
      bayId: "bay-2",
      apiUrl: "http://localhost:13214",
      dataDir: "/tmp/hub-data-bay-2/postgres",
      selectedEnv: {
        COCALC_BAY_ID: "bay-2",
        COCALC_BAY_LABEL: "",
        COCALC_BAY_REGION: "",
        COCALC_CLUSTER_ROLE: "attached",
        COCALC_CLUSTER_SEED_BAY_ID: "bay-0",
        COCALC_CLUSTER_SEED_CONAT_SERVER: "http://localhost:13004",
        COCALC_CLUSTER_SEED_CONAT_PASSWORD: "",
      },
    },
  );
});
