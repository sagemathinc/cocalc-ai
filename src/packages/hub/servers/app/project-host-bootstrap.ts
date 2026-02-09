import express, { Router, type Request } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/hub/logger";
import basePath from "@cocalc/backend/base-path";
import { buildBootstrapScriptWithStatus } from "@cocalc/server/cloud/bootstrap-host";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import {
  createBootstrapToken,
  verifyBootstrapToken,
} from "@cocalc/server/project-host/bootstrap-token";
import { resolveLaunchpadBootstrapUrl } from "@cocalc/server/launchpad/bootstrap-url";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("hub:servers:app:project-host-bootstrap");

function pool() {
  return getPool();
}

function extractToken(req: Request): string | undefined {
  const header = req.get("authorization");
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function resolveBootstrapPyPath(): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.COCALC_BOOTSTRAP_PY,
    process.env.COCALC_BUNDLE_DIR
      ? join(process.env.COCALC_BUNDLE_DIR, "bundle", "bootstrap", "bootstrap.py")
      : undefined,
    join(process.cwd(), "packages/server/cloud/bootstrap/bootstrap.py"),
    join(process.cwd(), "src/packages/server/cloud/bootstrap/bootstrap.py"),
    join(__dirname, "../../../../server/cloud/bootstrap/bootstrap.py"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveNebiusSetupPath(): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.COCALC_NEBIUS_SETUP_SH,
    process.env.COCALC_BUNDLE_DIR
      ? join(
          process.env.COCALC_BUNDLE_DIR,
          "bundle",
          "nebius",
          "nebius-setup.sh",
        )
      : undefined,
    join(process.cwd(), "packages/server/cloud/nebius/nebius-setup.sh"),
    join(process.cwd(), "src/packages/server/cloud/nebius/nebius-setup.sh"),
    join(__dirname, "../../../../server/cloud/nebius/nebius-setup.sh"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveGcpSetupPath(): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.COCALC_GCP_SETUP_SH,
    process.env.COCALC_BUNDLE_DIR
      ? join(process.env.COCALC_BUNDLE_DIR, "bundle", "gcp", "gcp-setup.sh")
      : undefined,
    join(process.cwd(), "packages/server/cloud/gcp/gcp-setup.sh"),
    join(process.cwd(), "src/packages/server/cloud/gcp/gcp-setup.sh"),
    join(__dirname, "../../../../server/cloud/gcp/gcp-setup.sh"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function loadHostRow(hostId: string): Promise<any> {
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [hostId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  return row;
}

async function updateBootstrapStatus(
  hostId: string,
  status: string,
  message?: string,
): Promise<void> {
  const { rows } = await pool().query(
    `SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [hostId],
  );
  const metadata = rows[0]?.metadata ?? {};
  metadata.bootstrap = {
    ...(metadata.bootstrap ?? {}),
    status,
    updated_at: new Date().toISOString(),
    ...(message ? { message } : {}),
  };
  await pool().query(
    `UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [hostId, metadata],
  );
}

export default function init(router: Router) {
  const jsonParser = express.json({ limit: "256kb" });

  router.get("/project-host/bootstrap.py", async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing bootstrap token");
        return;
      }
      const tokenInfo = await verifyBootstrapToken(token, {
        purpose: "bootstrap",
      });
      if (!tokenInfo) {
        res.status(401).send("invalid bootstrap token");
        return;
      }
      const path = resolveBootstrapPyPath();
      if (!path) {
        res.status(500).send("bootstrap.py not found");
        return;
      }
      const contents = readFileSync(path, "utf8");
      res.type("text/x-python").send(contents);
    } catch (err) {
      logger.warn("bootstrap.py fetch failed", err);
      res.status(500).send("bootstrap.py fetch failed");
    }
  });

  router.get("/project-host/nebius-setup.sh", async (_req, res) => {
    try {
      const path = resolveNebiusSetupPath();
      if (!path) {
        res.status(500).send("nebius-setup.sh not found");
        return;
      }
      const contents = readFileSync(path, "utf8");
      res.type("text/x-sh").send(contents);
    } catch (err) {
      logger.warn("nebius-setup.sh fetch failed", err);
      res.status(500).send("nebius-setup.sh fetch failed");
    }
  });

  router.get("/project-host/gcp-setup.sh", async (_req, res) => {
    try {
      const path = resolveGcpSetupPath();
      if (!path) {
        res.status(500).send("gcp-setup.sh not found");
        return;
      }
      const contents = readFileSync(path, "utf8");
      res.type("text/x-sh").send(contents);
    } catch (err) {
      logger.warn("gcp-setup.sh fetch failed", err);
      res.status(500).send("gcp-setup.sh fetch failed");
    }
  });

  router.get("/project-host/bootstrap", async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing bootstrap token");
        return;
      }
      const tokenInfo = await verifyBootstrapToken(token, {
        purpose: "bootstrap",
      });
      if (!tokenInfo) {
        res.status(401).send("invalid bootstrap token");
        return;
      }
      const hostRow = await loadHostRow(tokenInfo.host_id);
      let baseUrl: string;
      const machine: HostMachine = hostRow?.metadata?.machine ?? {};
      const selfHostMode = machine?.metadata?.self_host_mode;
      const isSelfHostLocal =
        machine?.cloud === "self-host" &&
        (!selfHostMode || selfHostMode === "local");
      if (isSelfHostLocal) {
        const localConfig = getLaunchpadLocalConfig("local");
        const httpPort = localConfig.http_port ?? 9200;
        baseUrl = `http://127.0.0.1:${httpPort}`;
      } else {
      try {
        const resolved = await resolveLaunchpadBootstrapUrl({
          fallbackHost: req.get("host"),
          fallbackProtocol: req.protocol,
        });
        baseUrl = resolved.baseUrl;
      } catch {
        const hostHeader = req.get("host") ?? "";
        const proto = req.protocol;
        const base = basePath === "/" ? "" : basePath;
        baseUrl = `${proto}://${hostHeader}${base}`;
      }
      }
      const script = await buildBootstrapScriptWithStatus(
        hostRow,
        token,
        baseUrl,
        undefined,
      );
      res.type("text/x-shellscript").send(script);
    } catch (err) {
      logger.warn("bootstrap script failed", err);
      res.status(500).send("bootstrap script failed");
    }
  });

  router.post("/project-host/bootstrap/status", jsonParser, async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing bootstrap token");
        return;
      }
      const tokenInfo = await verifyBootstrapToken(token, {
        purpose: "bootstrap",
      });
      if (!tokenInfo) {
        res.status(401).send("invalid bootstrap token");
        return;
      }
      const status = String(req.body?.status ?? "");
      if (!status) {
        res.status(400).send("missing status");
        return;
      }
      const message = req.body?.message ? String(req.body.message) : undefined;
      await updateBootstrapStatus(tokenInfo.host_id, status, message);
      res.json({ ok: true });
    } catch (err) {
      logger.warn("bootstrap status update failed", err);
      res.status(500).send("bootstrap status update failed");
    }
  });

  router.get("/project-host/bootstrap/conat", async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).send("missing bootstrap token");
        return;
      }
      const tokenInfo = await verifyBootstrapToken(token, {
        purpose: "bootstrap",
      });
      if (!tokenInfo) {
        res.status(401).send("invalid bootstrap token");
        return;
      }
      const issued = await createBootstrapToken(tokenInfo.host_id, {
        purpose: "master-conat",
        ttlMs: 1000 * 60 * 60 * 24 * 365, // 1 year
      });
      res.type("text/plain").send(issued.token);
    } catch (err) {
      logger.warn("bootstrap conat token failed", err);
      res.status(500).send("bootstrap conat token failed");
    }
  });
}
