// Self-host connector endpoints for user-managed project-host VMs.
// These routes support pairing a local connector daemon, polling for
// VM lifecycle commands, and acknowledging results, all without inbound
// access to the user’s machine.
import express, { Router, type Request } from "express";

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/hub/logger";
import {
  createPairingTokenForHost,
  verifyConnectorToken,
} from "@cocalc/server/self-host/connector-tokens";
import { pairSelfHostConnector } from "@cocalc/server/self-host/pair";
import getAccount from "@cocalc/server/auth/get-account";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { enqueueCloudVmWorkOnce } from "@cocalc/server/cloud/db";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import { resolveOnPremHost } from "@cocalc/server/onprem";

const logger = getLogger("hub:servers:app:self-host-connector");

function pool() {
  return getPool();
}

function extractToken(req: Request): string | undefined {
  const header = req.get("authorization");
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function maybeAutoStartHost(connector: {
  connector_id: string;
  account_id: string;
}) {
  const { rows } = await pool().query<{
    id: string;
    status: string | null;
    metadata: any;
  }>(
    `SELECT id, status, metadata
     FROM project_hosts
     WHERE region=$1
       AND deleted IS NULL
       AND metadata->>'owner' = $2`,
    [connector.connector_id, connector.account_id],
  );
  if (!rows.length) return;
  const host = rows.find((row) => row.metadata?.machine?.cloud === "self-host");
  if (!host || host.status !== "off") return;
  const nextMetadata = { ...(host.metadata ?? {}) };
  const selfHostMeta = { ...(nextMetadata.self_host ?? {}) };
  if (!selfHostMeta.auto_start_pending) return;
  if (nextMetadata.bootstrap) {
    delete nextMetadata.bootstrap;
  }
  selfHostMeta.auto_start_pending = false;
  selfHostMeta.auto_start_queued_at = new Date().toISOString();
  nextMetadata.self_host = selfHostMeta;
  await pool().query(
    `UPDATE project_hosts
     SET status=$2, last_seen=$3, metadata=$4, updated=NOW()
     WHERE id=$1 AND deleted IS NULL`,
    [host.id, "starting", new Date(), nextMetadata],
  );
  await enqueueCloudVmWorkOnce({
    vm_id: host.id,
    action: "start",
    payload: { provider: "self-host" },
  });
  logger.debug("self-host auto-start queued", {
    host_id: host.id,
    connector_id: connector.connector_id,
  });
}

export default function init(router: Router) {
  const jsonParser = express.json({ limit: "256kb" });

  router.post("/self-host/pairing-token", jsonParser, async (req, res) => {
    try {
      const account_id = await getAccount(req);
      if (!account_id) {
        res.status(401).send("user must be signed in");
        return;
      }
      const hostId = String(req.body?.host_id ?? "");
      if (!hostId) {
        res.status(400).send("missing host_id");
        return;
      }
      const ttlSecondsRaw = req.body?.ttl_seconds;
      const ttlSeconds =
        typeof ttlSecondsRaw === "number" && ttlSecondsRaw > 0
          ? ttlSecondsRaw
          : undefined;
      let tokenInfo;
      try {
        tokenInfo = await createPairingTokenForHost({
          account_id,
          host_id: hostId,
          ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined,
        });
      } catch (err) {
        const message = String(err ?? "");
        if (message.includes("host not found")) {
          res.status(404).send("host not found");
          return;
        }
        if (message.includes("host is not self-hosted")) {
          res.status(400).send("host is not self-hosted");
          return;
        }
        logger.warn("pairing token creation failed", err);
        res.status(500).send("pairing token creation failed");
        return;
      }
      const launchpad = getLaunchpadLocalConfig("local");
      const sshHost =
        process.env.COCALC_SSHD_HOST ??
        process.env.COCALC_LAUNCHPAD_SSHD_HOST ??
        resolveOnPremHost();
      res.json({
        pairing_token: tokenInfo.token,
        expires: tokenInfo.expires,
        connector_id: tokenInfo.connector_id,
        launchpad: {
          http_port: launchpad.http_port,
          https_port: launchpad.https_port,
          sshd_port: launchpad.sshd_port,
          ssh_user: launchpad.ssh_user,
          ssh_host: sshHost,
        },
      });
    } catch (err) {
      logger.warn("pairing token creation failed", err);
      res.status(500).send("pairing token creation failed");
    }
  });

  router.post("/self-host/pair", jsonParser, async (req, res) => {
    try {
      const pairingToken = String(req.body?.pairing_token ?? "");
      if (!pairingToken) {
        res.status(400).send("missing pairing token");
        return;
      }
      const connectorInfo = (req.body?.connector_info ?? {}) as Record<
        string,
        any
      >;
      const response = await pairSelfHostConnector({
        pairingToken,
        connectorInfo,
      });
      res.json(response);
    } catch (err) {
      if (String(err).includes("invalid pairing token")) {
        res.status(401).send("invalid pairing token");
        return;
      }
      logger.warn("pairing failed", err);
      res.status(500).send("pairing failed");
    }
  });

  router.get("/self-host/next", async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing connector token");
        return;
      }
      const connector = await verifyConnectorToken(token);
      if (!connector) {
        res.status(401).send("invalid connector token");
        return;
      }
      await maybeAutoStartHost(connector);
      const { rows } = await pool().query(
        `SELECT command_id, action, payload, created
         FROM self_host_commands
         WHERE connector_id=$1
           AND state='pending'
         ORDER BY created ASC
         LIMIT 1`,
        [connector.connector_id],
      );
      const row = rows[0];
      if (!row) {
        res.status(204).send();
        return;
      }
      await pool().query(
        `UPDATE self_host_commands
         SET state='sent', updated=NOW()
         WHERE command_id=$1`,
        [row.command_id],
      );
      res.json({
        id: row.command_id,
        action: row.action,
        payload: row.payload ?? {},
        issued_at: row.created,
      });
    } catch (err) {
      logger.warn("self-host next failed", err);
      res.status(500).send("self-host next failed");
    }
  });

  router.post("/self-host/commands", jsonParser, async (req, res) => {
    try {
      const account_id = await getAccount(req);
      if (!account_id) {
        res.status(401).send("user must be signed in");
        return;
      }
      const connectorId = String(req.body?.connector_id ?? "");
      if (!connectorId) {
        res.status(400).send("missing connector_id");
        return;
      }
      const action = String(req.body?.action ?? "");
      const allowed = new Set([
        "create",
        "start",
        "stop",
        "delete",
        "status",
        "resize",
      ]);
      if (!allowed.has(action)) {
        res.status(400).send("invalid action");
        return;
      }
      const { rows } = await pool().query(
        `SELECT account_id FROM self_host_connectors
         WHERE connector_id=$1 AND revoked IS NOT TRUE`,
        [connectorId],
      );
      const connectorAccount = rows[0]?.account_id;
      if (!connectorAccount) {
        res.status(404).send("connector not found");
        return;
      }
      if (connectorAccount !== account_id && !(await isAdmin(account_id))) {
        res.status(403).send("not authorized");
        return;
      }
      const payload = req.body?.payload ?? {};
      const { rows: inserted } = await pool().query(
        `INSERT INTO self_host_commands
           (command_id, connector_id, action, payload, state, created, updated)
         VALUES (gen_random_uuid(), $1, $2, $3, 'pending', NOW(), NOW())
         RETURNING command_id`,
        [connectorId, action, payload],
      );
      res.json({ ok: true, command_id: inserted[0]?.command_id });
    } catch (err) {
      logger.warn("self-host command enqueue failed", err);
      res.status(500).send("self-host command enqueue failed");
    }
  });

  router.post("/self-host/ack", jsonParser, async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing connector token");
        return;
      }
      const connector = await verifyConnectorToken(token);
      if (!connector) {
        res.status(401).send("invalid connector token");
        return;
      }
      const commandId = String(req.body?.id ?? "");
      if (!commandId) {
        res.status(400).send("missing command id");
        return;
      }
      const status = String(req.body?.status ?? "ok");
      const result = req.body?.result ?? null;
      const error = req.body?.error ? String(req.body.error) : null;
      const nextState = status === "ok" ? "done" : "error";
      await pool().query(
        `UPDATE self_host_commands
         SET state=$3, result=$4, error=$5, updated=NOW()
         WHERE command_id=$1 AND connector_id=$2`,
        [commandId, connector.connector_id, nextState, result, error],
      );
      res.json({ ok: true });
    } catch (err) {
      logger.warn("self-host ack failed", err);
      res.status(500).send("self-host ack failed");
    }
  });
}
