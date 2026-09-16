import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import getPool from "@cocalc/database/pool";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION } from "@cocalc/server/purchases/lock-account-spending";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import type { FundingRolloutEvidence } from "@cocalc/util/compute-funding-rollout";
import { computeDeploymentNamespace } from "../resource-names";
import { getComputeVmConfig } from "../config";

const STARTED_AT = Date.now() - process.uptime() * 1000;

/** Explicit local-operator trust, not production fleet attestation. The operator
 * guarantees that this dedicated PG cluster/deployment has one hub writer (the
 * isolated approval listener may run inside that same PID). Inspect only this
 * process and its server identity; unrelated processes/environments are private.
 */
export async function verifyIsolatedQaFundingWriter(): Promise<FundingRolloutEvidence> {
  const database = process.env.COCALC_FUNDING_QA_DATABASE?.trim();
  const root = process.env.COCALC_FUNDING_QA_WORKTREE?.trim();
  const pgData = process.env.COCALC_FUNDING_QA_PG_DATA_DIRECTORY?.trim();
  const pgSocket = process.env.COCALC_FUNDING_QA_PG_SOCKET?.trim();
  const deployment = process.env.COCALC_FUNDING_QA_DEPLOYMENT_ID?.trim();
  const bay = getConfiguredBayId();
  if (
    process.env.COCALC_FUNDING_ISOLATED_QA !== "yes" ||
    !database ||
    !root ||
    !isAbsolute(root) ||
    !pgData ||
    !isAbsolute(pgData) ||
    !pgSocket ||
    !isAbsolute(pgSocket) ||
    !deployment ||
    deployment !== process.env.COCALC_COMPUTE_DEPLOYMENT_ID?.trim() ||
    isMultiBayCluster() ||
    getConfiguredClusterBayCatalog().some((b) => b.bay_id !== bay)
  )
    throw Error(
      "Isolated funding QA requires explicit one-bay PG cluster, worktree, and deployment identities.",
    );
  const config = await getComputeVmConfig();
  const namespace = computeDeploymentNamespace();
  if (config.environment !== "development" || !namespace)
    throw Error(
      "Isolated funding QA requires a development compute namespace.",
    );
  const { SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION } =
    await import("../worker");
  if (
    FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION !==
      FUNDING_WRITER_PROTOCOL_VERSION ||
    SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION !==
      FUNDING_WRITER_PROTOCOL_VERSION
  )
    throw Error("The running funding writer protocol is incompatible.");
  const worktree = await realpath(root);
  const rootStat = await stat(worktree);
  if (
    !process.getuid ||
    rootStat.uid !== process.getuid() ||
    (rootStat.mode & 0o022) !== 0
  )
    throw Error(
      "The funding QA worktree must be owned by the local operator and not writable by other users.",
    );
  const fingerprint = createHash("sha256");
  for (const module of [
    require.resolve("@cocalc/server/purchases/lock-account-spending"),
    require.resolve("../worker"),
    __filename,
  ]) {
    const file = await realpath(module);
    const path = relative(worktree, file);
    const metadata = await stat(file);
    if (
      !file.endsWith(".js") ||
      path.startsWith("..") ||
      isAbsolute(path) ||
      metadata.mtimeMs > STARTED_AT
    )
      throw Error(
        "Funding QA must run the current compiled writer build from its dedicated worktree; restart after building.",
      );
    fingerprint.update(await readFile(file));
  }
  const pool = getPool();
  const {
    rows: [server],
  } = await pool.query<{
    database: string;
    data_directory: string;
    socket_directories: string;
    server_addr: string | null;
    postmaster_started_at: Date;
  }>(`SELECT current_database() AS database,
       current_setting('data_directory') AS data_directory,
       current_setting('unix_socket_directories') AS socket_directories,
       inet_server_addr()::text AS server_addr,
       pg_postmaster_start_time() AS postmaster_started_at`);
  // Exact single socket directory only; ambiguous multiple endpoints fail closed.
  if (
    !server ||
    server.database !== database ||
    server.server_addr !== null ||
    server.socket_directories !== pgSocket ||
    pool.options.host !== pgSocket ||
    (await realpath(server.data_directory)) !== (await realpath(pgData))
  )
    throw Error(
      "The running hub is not connected to the explicitly isolated PostgreSQL socket/data directory.",
    );
  fingerprint.update(
    JSON.stringify([
      database,
      server.data_directory,
      pgSocket,
      server.postmaster_started_at,
      deployment,
      process.pid,
      STARTED_AT,
    ]),
  );
  const as_of = new Date();
  return {
    protocol_version: FUNDING_WRITER_PROTOCOL_VERSION,
    enforced: true,
    evidence_id: `isolated-qa:${bay}:${process.pid}:${namespace}:${fingerprint.digest("hex").slice(0, 16)}`,
    as_of: as_of.toISOString(),
    expires_at: new Date(as_of.valueOf() + 5000).toISOString(),
  };
}
