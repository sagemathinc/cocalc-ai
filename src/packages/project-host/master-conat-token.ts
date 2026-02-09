import { readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";

const DEFAULT_MASTER_CONAT_TOKEN_PATH = "/btrfs/data/secrets/master-conat-token";

export function getProjectHostMasterConatTokenPath(): string {
  return (
    process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN_PATH ??
    DEFAULT_MASTER_CONAT_TOKEN_PATH
  ).trim();
}

export function getProjectHostMasterConatToken(): string | undefined {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN ?? ""}`.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const tokenPath = getProjectHostMasterConatTokenPath();
  if (!tokenPath) return undefined;
  try {
    const value = readFileSync(tokenPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectHostMasterConatToken(token: string): void {
  const tokenPath = getProjectHostMasterConatTokenPath();
  if (!tokenPath) return;
  const value = token.trim();
  if (!value) {
    throw new Error("refusing to write empty master conat token");
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
}

function bootstrapConfigCandidates(): string[] {
  const fromEnv = `${process.env.COCALC_BOOTSTRAP_CONFIG_PATH ?? ""}`.trim();
  const candidates = new Set<string>();
  if (fromEnv) {
    candidates.add(fromEnv);
  }
  candidates.add("/root/cocalc-host/bootstrap/bootstrap-config.json");
  candidates.add("/home/ubuntu/cocalc-host/bootstrap/bootstrap-config.json");
  try {
    for (const user of readdirSync("/home")) {
      candidates.add(`/home/${user}/cocalc-host/bootstrap/bootstrap-config.json`);
    }
  } catch {
    // ignore missing /home etc.
  }
  return [...candidates];
}

export function getProjectHostBootstrapToken(): string | undefined {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_BOOTSTRAP_TOKEN ?? ""}`.trim();
  if (fromEnv) return fromEnv;
  for (const path of bootstrapConfigCandidates()) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { bootstrap_token?: string };
      const token = `${parsed?.bootstrap_token ?? ""}`.trim();
      if (token) return token;
    } catch {
      // keep trying candidates
    }
  }
  return undefined;
}

export type ProjectHostBootstrapConatSource = {
  bootstrap_token: string;
  conat_url: string;
  ca_cert_path?: string;
};

function readBootstrapConfig():
  | {
      bootstrap_token?: string;
      conat_url?: string;
      ca_cert_path?: string;
    }
  | undefined {
  for (const path of bootstrapConfigCandidates()) {
    try {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw);
    } catch {
      // keep trying candidates
    }
  }
  return undefined;
}

export function getProjectHostBootstrapConatSource():
  | ProjectHostBootstrapConatSource
  | undefined {
  const fromEnvToken = `${process.env.COCALC_PROJECT_HOST_BOOTSTRAP_TOKEN ?? ""}`.trim();
  const fromEnvConatUrl = `${
    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_CONAT_URL ??
    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_MASTER_CONAT_URL ??
    ""
  }`.trim();
  const fromEnvCaPath = `${process.env.COCALC_PROJECT_HOST_BOOTSTRAP_CA_CERT_PATH ?? ""}`.trim();
  if (fromEnvToken && fromEnvConatUrl) {
    return {
      bootstrap_token: fromEnvToken,
      conat_url: fromEnvConatUrl,
      ...(fromEnvCaPath ? { ca_cert_path: fromEnvCaPath } : {}),
    };
  }
  const parsed = readBootstrapConfig();
  const bootstrap_token = `${parsed?.bootstrap_token ?? ""}`.trim();
  const conat_url = `${parsed?.conat_url ?? ""}`.trim();
  const ca_cert_path = `${parsed?.ca_cert_path ?? ""}`.trim();
  if (!bootstrap_token || !conat_url) return undefined;
  return {
    bootstrap_token,
    conat_url,
    ...(ca_cert_path ? { ca_cert_path } : {}),
  };
}

export async function fetchMasterConatTokenViaBootstrap(
  source: ProjectHostBootstrapConatSource,
  timeoutMs = 20_000,
): Promise<string> {
  const url = new URL(source.conat_url);
  const useHttps = url.protocol === "https:";
  const requestFn = useHttps ? httpsRequest : httpRequest;
  const headers = {
    Authorization: `Bearer ${source.bootstrap_token}`,
    "User-Agent": "cocalc-project-host/1.0 (master-conat-rotate)",
    Accept: "text/plain,*/*",
  };
  const ca = source.ca_cert_path ? readFileSync(source.ca_cert_path, "utf8") : undefined;

  return await new Promise<string>((resolve, reject) => {
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        ...(useHttps && ca ? { ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").trim();
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            if (!body) {
              reject(new Error("empty master conat token response"));
              return;
            }
            resolve(body);
            return;
          }
          reject(
            new Error(
              `bootstrap token fetch failed: status=${res.statusCode} body=${body.slice(
                0,
                240,
              )}`,
            ),
          );
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("bootstrap token fetch timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}
