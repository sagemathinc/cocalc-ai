const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeHubCluster, toEnvLines } = require("./hub-cluster.js");

test("normalizeHubCluster supports legacy two-bay env", () => {
  const root = "/tmp/cocalc-dev-hub";
  const cluster = normalizeHubCluster(
    {
      COCALC_BAY_ID: "bay-0",
      HUB_PORT: "13004",
      HUB_BIND_HOST: "localhost",
      HUB_CMD: "./packages/hub/bin/start.sh postgres",
      HUB_DEBUG_FILE: `${root}/log`,
      HUB_STDOUT_LOG: `${root}/hub.stdout.log`,
      HUB_ENABLE_SECOND_BAY: "1",
      HUB_SECOND_BAY_ID: "bay-1",
      HUB_SECOND_BAY_PORT: "13114",
      HUB_SECOND_BAY_BIND_HOST: "localhost",
      HUB_SECOND_BAY_DATA_DIR: `${root}/bay-1-data`,
    },
    { root },
  );

  assert.equal(cluster.primaryBayId, "bay-0");
  assert.equal(cluster.seedBayId, "bay-0");
  assert.equal(cluster.bays.length, 2);
  assert.equal(cluster.primary.role, "seed");
  assert.deepEqual(
    cluster.bays.map((bay) => ({
      id: bay.id,
      role: bay.role,
      port: bay.port,
      seed: bay.seedBayId,
    })),
    [
      { id: "bay-0", role: "seed", port: 13004, seed: "bay-0" },
      { id: "bay-1", role: "attached", port: 13114, seed: "bay-0" },
    ],
  );
});

test("normalizeHubCluster supports structured three-bay config", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cocalc-hub-cluster-"),
  );
  try {
    const configFile = path.join(root, "hub-cluster.json");
    await fs.promises.writeFile(
      configFile,
      JSON.stringify(
        {
          seed_bay_id: "bay-0",
          bays: [
            { id: "bay-0", port: 9100 },
            { id: "bay-1", port: 13114, region: "us-west-2" },
            {
              id: "bay-2",
              port: 13214,
              bind_host: "0.0.0.0",
              data_dir: "./data/bay-2",
            },
          ],
        },
        null,
        2,
      ),
    );

    const cluster = normalizeHubCluster(
      {
        HUB_DEV_CLUSTER_CONFIG: configFile,
        HUB_CMD: "./packages/hub/bin/start.sh postgres",
        HUB_BIND_HOST: "localhost",
        HUB_PORT: "9100",
        COCALC_BAY_ID: "bay-0",
        HUB_STDOUT_LOG: path.join(root, "hub.stdout.log"),
        HUB_DEBUG_FILE: path.join(root, "log"),
      },
      { root },
    );

    assert.equal(cluster.primaryBayId, "bay-0");
    assert.equal(cluster.seedBayId, "bay-0");
    assert.equal(cluster.bays.length, 3);
    assert.equal(
      cluster.bays[1].stateDir,
      path.join(root, ".local", "hub-daemon-bay-1"),
    );
    assert.equal(cluster.bays[2].dataDir, path.join(root, "data", "bay-2"));
    assert.equal(cluster.bays[2].seedConatServer, "http://localhost:9100");
    assert.equal(
      cluster.bays[2].softwareBaseUrlForce,
      "http://127.0.0.1:13214/software",
    );
    assert.equal(cluster.bays[0].publicUrl, "");
    assert.equal(cluster.bays[1].publicUrl, "");
    assert.equal(cluster.bays[2].publicUrl, "");

    const envLines = toEnvLines(cluster);
    assert.ok(envLines.includes("HUB_CLUSTER_BAY_COUNT=3"));
    assert.ok(envLines.includes("HUB_CLUSTER_BAY_2_ID=bay-2"));
    assert.ok(
      envLines.includes(
        "HUB_CLUSTER_BAY_2_SEED_CONAT_SERVER=http://localhost:9100",
      ),
    );
    assert.ok(envLines.includes("HUB_CLUSTER_BAY_PUBLIC_URLS="));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
