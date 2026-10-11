/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Credentials for one sensor run. A sensor is the agent on a schedule, so a
// run gets what a turn of the agent gets, as the approving account: the agent
// identity and the project CLI token always, and the connectors the spec
// lists (CoCalc access, GitHub, Cloudflare) if that account gave them to this
// agent. Everything is issued for this run only and ended when it finishes.

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type {
  SensorConnector,
  SensorRunCredentials,
} from "@cocalc/conat/agents/sensors";
import { issueProjectHostAgentAuthTokenInternalHelper } from "@cocalc/server/conat/api/hosts-connection-auth";
import { sensorConnectors } from "./cocalc-connector-routing";
import { agentStore } from "./store";

const logger = getLogger("agents:sensor-credentials");

/** Longer than the longest run (300 s) plus container start. */
const BEARER_TTL_SECONDS = 15 * 60;

export interface SensorRunLease {
  credentials: SensorRunCredentials;
  /** Connectors the spec uses that this agent does not have for the account. */
  missing: SensorConnector[];
  /** Keep short-lived connector keys alive during a long run. */
  renew: () => Promise<void>;
  /** End everything issued for the run. Never throws. */
  release: () => Promise<void>;
}

export async function issueSensorRunCredentials({
  agent,
  account_id,
  host_id,
  run_id,
  uses,
}: {
  agent: AgentIdentity;
  account_id: string;
  host_id: string;
  run_id: string;
  uses: SensorConnector[];
}): Promise<SensorRunLease> {
  const project_id = agent.project_id;
  const db = agentStore();
  const cleanups: (() => Promise<unknown>)[] = [];
  const release = async () => {
    for (const cleanup of cleanups.reverse())
      await Promise.resolve()
        .then(cleanup)
        .catch((err) =>
          logger.warn("sensor run credential cleanup failed", {
            run_id,
            err: `${err}`,
          }),
        );
    cleanups.length = 0;
  };
  try {
    // The agent identity for this run: `cocalc agent send`, memory, sensors.
    const identity = await db.issue(agent, run_id, account_id);
    cleanups.push(() =>
      db.query(
        "UPDATE agent_identity_runs SET ended_at=now() WHERE agent_id=$1 AND run_id=$2 AND ended_at IS NULL",
        [agent.agent_id, run_id],
      ),
    );
    // The own-project CLI token every agent turn has; it expires on its own.
    const { token: bearer } =
      await issueProjectHostAgentAuthTokenInternalHelper({
        host_id,
        account_id,
        project_id,
        ttl_seconds: BEARER_TTL_SECONDS,
      });
    const credentials: SensorRunCredentials = { identity, bearer };
    const missing: SensorConnector[] = [];
    const turn_ref = {
      chat_path: agent.path,
      message_date: new Date().toISOString(),
      message_id: run_id,
      thread_id: agent.thread_id,
      sensor_run_id: run_id,
    };
    const base = {
      account_id,
      host_id,
      agent_id: agent.agent_id,
      source_project_id: project_id,
      run_id,
    };
    let renew = async () => {};
    if (uses.includes("cocalc")) {
      const key = await sensorConnectors.begin({
        ...base,
        idempotency_key: randomUUID(),
        turn_ref,
      });
      if (key) {
        credentials.connector_key = key.secret;
        cleanups.push(() =>
          sensorConnectors.end({ ...base, turn_id: key.turn_id }),
        );
        renew = async () => {
          await sensorConnectors.renew({
            ...base,
            turn_id: key.turn_id,
            turn_ref,
          });
        };
      } else {
        missing.push("cocalc");
      }
    }
    const cli = uses.filter(
      (c): c is "github" | "cloudflare" => c === "github" || c === "cloudflare",
    );
    if (cli.length > 0) {
      // Only the connectors this sensor uses are minted at the account's home.
      const tokens = (
        (await sensorConnectors.beginCli({
          ...base,
          turn_ref,
          connectors: cli,
        })) ?? []
      ).filter((token) => cli.includes(token.connector as any));
      credentials.cli_tokens = tokens;
      for (const connector of cli)
        if (!tokens.some((token) => token.connector === connector))
          missing.push(connector);
    }
    return { credentials, missing, renew, release };
  } catch (err) {
    await release();
    throw err;
  }
}
