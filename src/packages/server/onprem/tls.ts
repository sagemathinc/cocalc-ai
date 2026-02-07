import { networkInterfaces } from "node:os";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("onprem:host");

let warnedLegacyHost = false;

export function resolveOnPremHost(fallbackHost?: string | null): string {
  const legacyHost =
    process.env.COCALC_LAUNCHPAD_HOST ?? process.env.COCALC_ONPREM_HOST;
  if (!process.env.COCALC_PUBLIC_HOST && legacyHost && !warnedLegacyHost) {
    warnedLegacyHost = true;
    logger.warn(
      "COCALC_LAUNCHPAD_HOST/COCALC_ONPREM_HOST is deprecated; use COCALC_PUBLIC_HOST",
      { host: legacyHost },
    );
  }
  const explicit = process.env.COCALC_PUBLIC_HOST ?? legacyHost;
  const raw =
    explicit ??
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
  if (!explicit && isLocalHost(value)) {
    const detected = detectLanIp();
    if (detected) {
      logger.warn("onprem host resolves to localhost; using LAN IP", {
        host: detected,
      });
      return detected;
    }
    logger.warn("onprem host resolves to localhost; no LAN IP detected", {
      host: value,
    });
  }
  return value;
}

export function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  if (address.startsWith("172.")) {
    const octet = Number.parseInt(address.split(".")[1] ?? "", 10);
    return octet >= 16 && octet <= 31;
  }
  return false;
}

function detectLanIp(): string | undefined {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      candidates.push(addr.address);
    }
  }
  return candidates.find(isPrivateIpv4) ?? candidates[0];
}
