import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import ssh from "micro-key-producer/ssh.js";
import { getLaunchpadLocalConfig } from "./mode";

const logger = getLogger("launchpad:local:ssh-auth");

function normalizeSshKey(key?: string | null): string {
  if (!key) return "";
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return "";
  return `${parts[0]} ${parts[1]}`;
}

function derivePublicKeyFromSeed(seedBase64: string): string | null {
  try {
    const seed = Buffer.from(seedBase64, "base64url");
    if (seed.length !== 32) {
      return null;
    }
    const keypair = ssh(seed, "cocalc-pair");
    return normalizeSshKey(keypair.publicKey);
  } catch {
    return null;
  }
}

function formatAuthorizedKey(command: string, key: string): string {
  const options = [
    `command="${command.replace(/"/g, '\\"')}"`,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
    "no-port-forwarding",
  ];
  return `${options.join(",")} ${key}`;
}

function formatForwardKey(key: string, httpsPort: number): string {
  const options = [
    `permitopen="127.0.0.1:${httpsPort}"`,
    "no-agent-forwarding",
    "no-X11-forwarding",
    "no-pty",
  ];
  return `${options.join(",")} ${key}`;
}

async function main() {
  const presented = normalizeSshKey(process.argv[3] ?? process.argv[2]);
  if (!presented) {
    process.exit(0);
  }
  const commandPath = `${process.execPath} ${__dirname}/ssh-pair.js`;

  const { rows } = await getPool().query<{
    pairing_key_seed: string | null;
  }>(
    `
    SELECT pairing_key_seed
      FROM self_host_connector_tokens
     WHERE purpose='pairing'
       AND revoked IS NOT TRUE
       AND expires > NOW()
       AND pairing_key_seed IS NOT NULL
    `,
  );

  for (const row of rows) {
    if (!row.pairing_key_seed) continue;
    const expected = derivePublicKeyFromSeed(row.pairing_key_seed);
    if (!expected) continue;
    if (expected === presented) {
      process.stdout.write(`${formatAuthorizedKey(commandPath, expected)}\n`);
      process.exit(0);
    }
  }

  const localConfig = getLaunchpadLocalConfig("local");
  const httpPort = localConfig.http_port ?? localConfig.https_port ?? 443;
  const connectorRows = await getPool().query<{
    ssh_key_seed: string | null;
  }>(
    `
    SELECT ssh_key_seed
      FROM self_host_connectors
     WHERE revoked IS NOT TRUE
       AND ssh_key_seed IS NOT NULL
       AND token_hash IS NOT NULL
    `,
  );
  for (const row of connectorRows.rows) {
    if (!row.ssh_key_seed) continue;
    const expected = derivePublicKeyFromSeed(row.ssh_key_seed);
    if (!expected) continue;
    if (expected === presented) {
      process.stdout.write(`${formatForwardKey(expected, httpPort)}\n`);
      process.exit(0);
    }
  }

  const bootstrapRows = await getPool().query<{
    ssh_key_seed: string | null;
  }>(
    `
    SELECT ssh_key_seed
      FROM project_host_bootstrap_tokens
     WHERE purpose='bootstrap'
       AND revoked IS NOT TRUE
       AND expires > NOW()
       AND ssh_key_seed IS NOT NULL
    `,
  );
  for (const row of bootstrapRows.rows) {
    if (!row.ssh_key_seed) continue;
    const expected = derivePublicKeyFromSeed(row.ssh_key_seed);
    if (!expected) continue;
    if (expected === presented) {
      process.stdout.write(`${formatForwardKey(expected, httpPort)}\n`);
      process.exit(0);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  logger.warn("authorized keys command failed", { err: String(err) });
  process.exit(1);
});
