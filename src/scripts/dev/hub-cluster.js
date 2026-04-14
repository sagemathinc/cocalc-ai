#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

function trim(value) {
  return `${value ?? ""}`.trim();
}

function toNumber(value, fallback) {
  const n = Number(trim(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveMaybeRelative(root, value) {
  const raw = trim(value);
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

function localHubUrl(host, port) {
  const bindHost = trim(host) || "localhost";
  const urlHost = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost;
  return `http://${urlHost}:${toNumber(port, 9100)}`;
}

function readStructuredClusterConfig(env, root) {
  const inlineJson = trim(env.HUB_DEV_CLUSTER_JSON);
  if (inlineJson) {
    return JSON.parse(inlineJson);
  }
  const configFile = resolveMaybeRelative(root, env.HUB_DEV_CLUSTER_CONFIG);
  if (!configFile) return undefined;
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}

function legacyClusterConfig(env, root, stateDir) {
  const primaryBayId = trim(env.COCALC_BAY_ID) || "bay-0";
  const primary = {
    id: primaryBayId,
    port: toNumber(env.HUB_PORT, 9100),
    bind_host: trim(env.HUB_BIND_HOST) || "localhost",
    cmd: trim(env.HUB_CMD) || "./packages/hub/bin/start.sh postgres",
    state_dir: stateDir,
    data_dir: trim(env.DATA_BASE),
    debug_file: trim(env.HUB_DEBUG_FILE) || path.join(root, "log"),
    stdout_log:
      trim(env.HUB_STDOUT_LOG) || path.join(stateDir, "hub.stdout.log"),
    cloudflared_pid_file:
      trim(env.HUB_CLOUDFLARED_PID_FILE) ||
      path.join(stateDir, "cloudflared.pid"),
    label: trim(env.COCALC_BAY_LABEL),
    region: trim(env.COCALC_BAY_REGION),
    role: trim(env.COCALC_CLUSTER_ROLE) || "standalone",
  };

  if (trim(env.HUB_ENABLE_SECOND_BAY) !== "1") {
    return {
      primary_bay_id: primaryBayId,
      seed_bay_id:
        trim(env.COCALC_CLUSTER_SEED_BAY_ID) ||
        (primary.role === "attached" ? "" : primaryBayId),
      bays: [primary],
    };
  }

  const secondBayId = trim(env.HUB_SECOND_BAY_ID) || "bay-1";
  const secondStateDir =
    trim(env.HUB_SECOND_BAY_STATE_DIR) ||
    path.join(root, ".local", `hub-daemon-${secondBayId}`);
  return {
    primary_bay_id: primaryBayId,
    seed_bay_id: trim(env.COCALC_CLUSTER_SEED_BAY_ID) || primaryBayId,
    bays: [
      primary,
      {
        id: secondBayId,
        port: toNumber(
          env.HUB_SECOND_BAY_PORT,
          toNumber(env.HUB_PORT, 9100) + 10,
        ),
        bind_host:
          trim(env.HUB_SECOND_BAY_BIND_HOST) ||
          trim(env.HUB_BIND_HOST) ||
          "localhost",
        cmd: trim(env.HUB_SECOND_BAY_CMD) || trim(env.HUB_CMD),
        state_dir: secondStateDir,
        data_dir:
          trim(env.HUB_SECOND_BAY_DATA_DIR) ||
          path.join(root, ".local", `hub-data-${secondBayId}`),
        debug_file:
          trim(env.HUB_SECOND_BAY_DEBUG_FILE) ||
          path.join(secondStateDir, "log"),
        stdout_log:
          trim(env.HUB_SECOND_BAY_STDOUT_LOG) ||
          path.join(secondStateDir, "hub.stdout.log"),
        cloudflared_pid_file: path.join(secondStateDir, "cloudflared.pid"),
        region: trim(env.COCALC_BAY_REGION),
        role: "attached",
      },
    ],
  };
}

function normalizeBay(rawBay, idx, context) {
  const { root, primaryBayId, seedBayId, defaults, globalDefaults, bayCount } =
    context;
  const id = trim(rawBay.id);
  if (!id) {
    throw new Error(`hub cluster bay ${idx} is missing an id`);
  }
  const isPrimary = id === primaryBayId;
  const stateDir = resolveMaybeRelative(
    root,
    rawBay.state_dir ||
      rawBay.stateDir ||
      defaults.state_dir ||
      defaults.stateDir ||
      (isPrimary
        ? globalDefaults.primaryStateDir
        : path.join(root, ".local", `hub-daemon-${id}`)),
  );
  const dataDir = resolveMaybeRelative(
    root,
    rawBay.data_dir ||
      rawBay.dataDir ||
      defaults.data_dir ||
      defaults.dataDir ||
      (isPrimary
        ? globalDefaults.primaryDataDir
        : path.join(root, ".local", `hub-data-${id}`)),
  );
  const cmd = trim(rawBay.cmd || defaults.cmd) || globalDefaults.cmd;
  const bindHost =
    trim(
      rawBay.bind_host ||
        rawBay.bindHost ||
        defaults.bind_host ||
        defaults.bindHost,
    ) || globalDefaults.bindHost;
  const port = toNumber(
    rawBay.port,
    isPrimary
      ? globalDefaults.primaryPort
      : globalDefaults.primaryPort + idx * 10,
  );
  const debugFile = resolveMaybeRelative(
    root,
    rawBay.debug_file ||
      rawBay.debugFile ||
      defaults.debug_file ||
      defaults.debugFile ||
      (isPrimary
        ? globalDefaults.primaryDebugFile
        : path.join(stateDir, "log")),
  );
  const stdoutLog = resolveMaybeRelative(
    root,
    rawBay.stdout_log ||
      rawBay.stdoutLog ||
      defaults.stdout_log ||
      defaults.stdoutLog ||
      (isPrimary
        ? globalDefaults.primaryStdoutLog
        : path.join(stateDir, "hub.stdout.log")),
  );
  const cloudflaredPidFile = resolveMaybeRelative(
    root,
    rawBay.cloudflared_pid_file ||
      rawBay.cloudflaredPidFile ||
      defaults.cloudflared_pid_file ||
      defaults.cloudflaredPidFile ||
      (isPrimary
        ? globalDefaults.primaryCloudflaredPidFile
        : path.join(stateDir, "cloudflared.pid")),
  );
  const explicitRole = trim(
    rawBay.role || rawBay.cluster_role || rawBay.clusterRole,
  );
  let role = explicitRole;
  if (!role) {
    if (bayCount === 1) {
      role = globalDefaults.primaryRole || "standalone";
    } else {
      role = isPrimary ? "seed" : "attached";
    }
  }
  if (bayCount > 1 && isPrimary && role === "standalone") {
    role = "seed";
  }
  if (bayCount > 1 && isPrimary && role === "attached") {
    throw new Error(
      "primary bay cannot be attached in a multi-bay dev cluster",
    );
  }
  return {
    id,
    index: idx,
    isPrimary,
    port,
    bindHost,
    cmd,
    stateDir,
    dataDir,
    debugFile,
    stdoutLog,
    cloudflaredPidFile,
    label: trim(rawBay.label || rawBay.bay_label || rawBay.bayLabel),
    region: trim(rawBay.region || rawBay.bay_region || rawBay.bayRegion),
    role,
    seedBayId:
      role === "attached"
        ? seedBayId
        : role === "seed"
          ? seedBayId
          : trim(globalDefaults.primarySeedBayId),
    seedConatServer:
      role === "attached" ? "" : trim(globalDefaults.primarySeedConatServer),
    seedConatPassword:
      role === "attached"
        ? trim(rawBay.seed_conat_password || rawBay.seedConatPassword)
        : trim(globalDefaults.primarySeedConatPassword),
    softwareBaseUrlForce:
      trim(rawBay.software_base_url_force || rawBay.softwareBaseUrlForce) ||
      (isPrimary
        ? trim(globalDefaults.primarySoftwareBaseUrlForce)
        : `${localHubUrl(bindHost, port)}/software`),
    selfHostPairUrl:
      trim(rawBay.self_host_pair_url || rawBay.selfHostPairUrl) ||
      (isPrimary
        ? trim(globalDefaults.primarySelfHostPairUrl) ||
          `http://127.0.0.1:${globalDefaults.primaryPort}`
        : localHubUrl(bindHost, port)),
    publicUrl: trim(rawBay.public_url || rawBay.publicUrl),
  };
}

function normalizeHubCluster(env = process.env, opts = {}) {
  const root = opts.root || ROOT;
  const stateDir =
    resolveMaybeRelative(root, env.STATE_DIR) ||
    resolveMaybeRelative(root, env.COCALC_HUB_DAEMON_STATE_DIR) ||
    path.join(root, ".local", "hub-daemon");
  const globalDefaults = {
    cmd: trim(env.HUB_CMD) || "./packages/hub/bin/start.sh postgres",
    bindHost: trim(env.HUB_BIND_HOST) || "localhost",
    primaryPort: toNumber(env.HUB_PORT, 9100),
    primaryStateDir: stateDir,
    primaryDataDir: trim(env.DATA_BASE),
    primaryDebugFile: trim(env.HUB_DEBUG_FILE) || path.join(root, "log"),
    primaryStdoutLog:
      trim(env.HUB_STDOUT_LOG) || path.join(stateDir, "hub.stdout.log"),
    primaryCloudflaredPidFile:
      trim(env.HUB_CLOUDFLARED_PID_FILE) ||
      path.join(stateDir, "cloudflared.pid"),
    primaryRole: trim(env.COCALC_CLUSTER_ROLE) || "standalone",
    primarySeedBayId: trim(env.COCALC_CLUSTER_SEED_BAY_ID),
    primarySeedConatServer: trim(env.COCALC_CLUSTER_SEED_CONAT_SERVER),
    primarySeedConatPassword: trim(env.COCALC_CLUSTER_SEED_CONAT_PASSWORD),
    primarySoftwareBaseUrlForce: trim(env.HUB_SOFTWARE_BASE_URL_FORCE),
    primarySelfHostPairUrl: trim(env.HUB_SELF_HOST_PAIR_URL),
  };

  const rawConfig =
    readStructuredClusterConfig(env, root) ||
    legacyClusterConfig(env, root, stateDir);
  const baysRaw = Array.isArray(rawConfig?.bays) ? rawConfig.bays : [];
  if (baysRaw.length === 0) {
    throw new Error("hub cluster config must define at least one bay");
  }

  const firstBayId = trim(baysRaw[0]?.id) || trim(env.COCALC_BAY_ID) || "bay-0";
  const primaryBayId =
    trim(rawConfig.primary_bay_id || rawConfig.primaryBayId) ||
    trim(env.COCALC_BAY_ID) ||
    firstBayId;
  const seedBayId =
    trim(rawConfig.seed_bay_id || rawConfig.seedBayId) ||
    (baysRaw.length > 1
      ? primaryBayId
      : globalDefaults.primarySeedBayId || primaryBayId);
  if (baysRaw.length > 1 && seedBayId !== primaryBayId) {
    throw new Error(
      "multi-bay dev clusters currently require primary_bay_id to match seed_bay_id",
    );
  }

  const defaults =
    rawConfig.defaults && typeof rawConfig.defaults === "object"
      ? rawConfig.defaults
      : {};
  const context = {
    root,
    primaryBayId,
    seedBayId,
    defaults,
    globalDefaults,
    bayCount: baysRaw.length,
  };
  const bays = baysRaw.map((bay, idx) => normalizeBay(bay, idx, context));
  const primary = bays.find((bay) => bay.id === primaryBayId);
  if (!primary) {
    throw new Error(
      `primary bay '${primaryBayId}' is not defined in hub cluster config`,
    );
  }
  const seed = bays.find((bay) => bay.id === seedBayId);
  if (!seed) {
    throw new Error(
      `seed bay '${seedBayId}' is not defined in hub cluster config`,
    );
  }
  const seedServer = localHubUrl(seed.bindHost, seed.port);
  for (const bay of bays) {
    if (bay.role === "attached") {
      bay.seedBayId = seed.id;
      bay.seedConatServer = seedServer;
    }
  }
  return {
    root,
    stateDir,
    primaryBayId: primary.id,
    seedBayId: seed.id,
    primaryBayIndex: primary.index,
    seedBayIndex: seed.index,
    bays,
    primary,
    seed,
  };
}

function toEnvLines(cluster) {
  const lines = [
    `COCALC_BAY_ID=${cluster.primary.id}`,
    `COCALC_BAY_LABEL=${cluster.primary.label}`,
    `COCALC_BAY_REGION=${cluster.primary.region}`,
    `COCALC_CLUSTER_ROLE=${cluster.primary.role}`,
    `COCALC_CLUSTER_SEED_BAY_ID=${cluster.primary.seedBayId}`,
    `COCALC_CLUSTER_SEED_CONAT_SERVER=${cluster.primary.seedConatServer}`,
    `COCALC_CLUSTER_SEED_CONAT_PASSWORD=${cluster.primary.seedConatPassword}`,
    `HUB_CMD=${cluster.primary.cmd}`,
    `HUB_PORT=${cluster.primary.port}`,
    `HUB_BIND_HOST=${cluster.primary.bindHost}`,
    `HUB_DEBUG_FILE=${cluster.primary.debugFile}`,
    `HUB_STDOUT_LOG=${cluster.primary.stdoutLog}`,
    `HUB_CLOUDFLARED_PID_FILE=${cluster.primary.cloudflaredPidFile}`,
    `HUB_SOFTWARE_BASE_URL_FORCE=${cluster.primary.softwareBaseUrlForce}`,
    `HUB_SELF_HOST_PAIR_URL=${cluster.primary.selfHostPairUrl}`,
    `HUB_CLUSTER_BAY_COUNT=${cluster.bays.length}`,
    `HUB_CLUSTER_PRIMARY_BAY_ID=${cluster.primaryBayId}`,
    `HUB_CLUSTER_PRIMARY_BAY_INDEX=${cluster.primaryBayIndex}`,
    `HUB_CLUSTER_SEED_BAY_ID=${cluster.seedBayId}`,
    `HUB_CLUSTER_SEED_BAY_INDEX=${cluster.seedBayIndex}`,
    `HUB_CLUSTER_BAY_IDS=${cluster.bays.map((bay) => bay.id).join(",")}`,
  ];
  for (const bay of cluster.bays) {
    const prefix = `HUB_CLUSTER_BAY_${bay.index}_`;
    lines.push(`${prefix}ID=${bay.id}`);
    lines.push(`${prefix}ROLE=${bay.role}`);
    lines.push(`${prefix}IS_PRIMARY=${bay.isPrimary ? "1" : "0"}`);
    lines.push(`${prefix}PORT=${bay.port}`);
    lines.push(`${prefix}BIND_HOST=${bay.bindHost}`);
    lines.push(`${prefix}CMD=${bay.cmd}`);
    lines.push(`${prefix}STATE_DIR=${bay.stateDir}`);
    lines.push(`${prefix}DATA_DIR=${bay.dataDir}`);
    lines.push(`${prefix}DEBUG_FILE=${bay.debugFile}`);
    lines.push(`${prefix}STDOUT_LOG=${bay.stdoutLog}`);
    lines.push(`${prefix}CLOUDFLARED_PID_FILE=${bay.cloudflaredPidFile}`);
    lines.push(`${prefix}LABEL=${bay.label}`);
    lines.push(`${prefix}REGION=${bay.region}`);
    lines.push(`${prefix}SEED_BAY_ID=${bay.seedBayId}`);
    lines.push(`${prefix}SEED_CONAT_SERVER=${bay.seedConatServer}`);
    lines.push(`${prefix}SEED_CONAT_PASSWORD=${bay.seedConatPassword}`);
    lines.push(`${prefix}SOFTWARE_BASE_URL_FORCE=${bay.softwareBaseUrlForce}`);
    lines.push(`${prefix}SELF_HOST_PAIR_URL=${bay.selfHostPairUrl}`);
    lines.push(`${prefix}PUBLIC_URL=${bay.publicUrl}`);
  }
  lines.push(
    `HUB_CLUSTER_BAY_PUBLIC_URLS=${cluster.bays
      .filter((bay) => bay.publicUrl)
      .map((bay) => `${bay.id}=${bay.publicUrl}`)
      .join(",")}`,
  );
  return lines;
}

function main() {
  const mode = trim(process.argv[2]) || "shell";
  const cluster = normalizeHubCluster(process.env);
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(cluster, null, 2)}\n`);
    return;
  }
  for (const line of toEnvLines(cluster)) {
    process.stdout.write(`${line}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`${err?.message ?? err}`);
    process.exit(1);
  }
}

module.exports = {
  localHubUrl,
  normalizeHubCluster,
  toEnvLines,
};
