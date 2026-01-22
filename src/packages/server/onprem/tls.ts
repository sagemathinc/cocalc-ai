import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import selfsigned from "selfsigned";
import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("onprem:tls");

const DEFAULT_ROTATE_DAYS = 30;
const DEFAULT_CERT_DIR = join(secrets, "launchpad-https");

export type OnPremTlsInfo = {
  keyPath: string;
  certPath: string;
  host: string;
  selfSigned: boolean;
};

export function resolveOnPremHost(fallbackHost?: string | null): string {
  const raw =
    process.env.COCALC_LAUNCHPAD_HOST ??
    process.env.COCALC_ONPREM_HOST ??
    process.env.HOST ??
    process.env.COCALC_HUB_HOSTNAME ??
    fallbackHost ??
    "localhost";
  const value = String(raw).trim();
  if (!value) return "localhost";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).hostname || "localhost";
    } catch {
      return "localhost";
    }
  }
  if (value === "0.0.0.0" || value === "::") {
    logger.warn("onprem host is a bind address; use a reachable hostname", {
      host: value,
    });
  }
  return value;
}

export function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function parseRotateDays(): number {
  const raw =
    process.env.COCALC_LAUNCHPAD_CERT_ROTATE_DAYS ??
    process.env.COCALC_ONPREM_CERT_ROTATE_DAYS ??
    `${DEFAULT_ROTATE_DAYS}`;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ROTATE_DAYS;
  }
  return parsed;
}

function buildAltNames(hostname: string) {
  const names = new Set<string>([hostname, "localhost", "127.0.0.1", "::1"]);
  return Array.from(names).map((name) => {
    if (isIP(name)) {
      return { type: 7, ip: name };
    }
    return { type: 2, value: name };
  });
}

function getCertExpiry(certPem: string): Date | undefined {
  try {
    const cert = new X509Certificate(certPem);
    return new Date(cert.validTo);
  } catch {
    return undefined;
  }
}

function shouldRotateCert(certPem: string, rotateDays: number): boolean {
  const expiry = getCertExpiry(certPem);
  if (!expiry || Number.isNaN(expiry.getTime())) {
    return true;
  }
  const rotateMs = rotateDays * 24 * 60 * 60 * 1000;
  return expiry.getTime() - Date.now() <= rotateMs;
}

function logCertExpiry(certPath: string, certPem: string) {
  const expiry = getCertExpiry(certPem);
  if (!expiry || Number.isNaN(expiry.getTime())) {
    logger.warn("onprem TLS cert expiry could not be parsed", { certPath });
    return;
  }
  logger.info(`onprem TLS cert expires at ${expiry.toISOString()}`, {
    certPath,
  });
}

export function ensureOnPremTls(opts: {
  host?: string | null;
  existingKey?: string | null;
  existingCert?: string | null;
  allowLocalHttp?: boolean;
  scheduled?: boolean;
  rotateDays?: number;
} = {}): OnPremTlsInfo | null {
  const host = resolveOnPremHost(opts.host ?? null);
  const allowLocalHttp = opts.allowLocalHttp ?? true;
  const rotateDays = opts.rotateDays ?? parseRotateDays();
  const existingKey = opts.existingKey ?? undefined;
  const existingCert = opts.existingCert ?? undefined;

  if (allowLocalHttp && !existingKey && !existingCert && isLocalHost(host)) {
    return null;
  }

  const explicitCert = Boolean(existingKey && existingCert);
  if (explicitCert) {
    try {
      const certPem = readFileSync(existingCert as string, "utf8");
      if (!opts.scheduled) {
        logCertExpiry(existingCert as string, certPem);
      }
      if (!shouldRotateCert(certPem, rotateDays)) {
        return {
          keyPath: existingKey as string,
          certPath: existingCert as string,
          host,
          selfSigned: false,
        };
      }
      if (opts.scheduled) {
        logger.warn(
          "onprem TLS cert is expired or near expiry; update your certs before expiry",
          { certPath: existingCert },
        );
        return {
          keyPath: existingKey as string,
          certPath: existingCert as string,
          host,
          selfSigned: false,
        };
      }
      logger.warn(
        "onprem TLS cert is expired or near expiry; falling back to self-signed",
        { certPath: existingCert },
      );
    } catch {
      if (opts.scheduled) {
        logger.warn("onprem TLS cert unreadable; update your certs", {
          certPath: existingCert,
        });
        return {
          keyPath: existingKey as string,
          certPath: existingCert as string,
          host,
          selfSigned: false,
        };
      }
      logger.warn("onprem TLS cert unreadable; falling back to self-signed", {
        certPath: existingCert,
      });
    }
  }

  const certDir = DEFAULT_CERT_DIR;
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  let key: string | undefined;
  let cert: string | undefined;
  try {
    key = readFileSync(keyPath, "utf8");
    cert = readFileSync(certPath, "utf8");
  } catch {
    key = undefined;
    cert = undefined;
  }

  const needsRotation = !key || !cert || shouldRotateCert(cert, rotateDays);
  if (needsRotation) {
    mkdirSync(certDir, { recursive: true });
    const attrs = [{ name: "commonName", value: host }];
    const altNames = buildAltNames(host);
    const pems = selfsigned.generate(attrs, {
      days: 365 * 5,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames }],
    });
    key = pems.private;
    cert = pems.cert;
    writeFileSync(keyPath, key, { mode: 0o600 });
    writeFileSync(certPath, cert, { mode: 0o644 });
    process.env.COCALC_LAUNCHPAD_SELF_SIGNED = "1";
    if (!opts.scheduled) {
      logCertExpiry(certPath, cert);
    }
    if (opts.scheduled) {
      logger.warn("onprem TLS cert rotated; restart to apply new cert", {
        certPath,
      });
    }
  }

  process.env.COCALC_LAUNCHPAD_HTTPS_CERT = certPath;
  process.env.COCALC_LAUNCHPAD_HTTPS_KEY = keyPath;

  return {
    keyPath,
    certPath,
    host,
    selfSigned: true,
  };
}

let rotationTimer: NodeJS.Timeout | null = null;
export function scheduleOnPremCertRotation(opts?: {
  host?: string | null;
  allowLocalHttp?: boolean;
  rotateDays?: number;
  existingKey?: string | null;
  existingCert?: string | null;
}): void {
  if (rotationTimer) {
    return;
  }
  const intervalMs = 24 * 60 * 60 * 1000;
  rotationTimer = setInterval(() => {
    try {
      ensureOnPremTls({ ...opts, scheduled: true });
    } catch (err) {
      logger.warn("onprem TLS rotation check failed", { err });
    }
  }, intervalMs);
}
