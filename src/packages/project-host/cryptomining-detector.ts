/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ProjectCryptominingEvidence,
  ProjectCryptominingSignal,
} from "@cocalc/conat/hub/api/system";
import { lookup } from "node:dns/promises";

const DETECTOR_VERSION = "project-host-cryptomining-v1";
const MAX_COMMAND_LENGTH = 500;
const MAX_SIGNALS = 8;
const KNOWN_POOL_ADDRESS_CACHE_TTL_MS = 10 * 60 * 1000;

const KNOWN_MINING_POOL_HOSTS = [
  "stratum.cereblix.com",
  "rx.unmineable.com",
  "randomxmonero.auto.nicehash.com",
  "pool.supportxmr.com",
  "gulf.moneroocean.stream",
  "xmr.2miners.com",
  "xmr-eu1.nanopool.org",
  "xmr-us-east1.nanopool.org",
  "de.monero.herominers.com",
  "ca.monero.herominers.com",
  "monero.hashvault.pro",
  "xmr-us-west1.nanopool.org",
  "xmrpool.eu",
] as const;

const MINING_POOL_PORTS = new Set([
  3333, 4444, 5555, 7777, 8888, 9999, 14444, 18081, 18089, 18192, 20189, 20206,
]);

type Pattern = {
  id: string;
  kind: ProjectCryptominingSignal["kind"];
  regex: RegExp;
};

const COMMAND_PATTERNS: Pattern[] = [
  {
    id: "xmrig-binary",
    kind: "process_command",
    regex: /(?:^|[\/\s])xmrig(?:$|\s)/i,
  },
  {
    id: "cpuminer-binary",
    kind: "process_command",
    regex: /(?:^|[\/\s])(?:cpuminer|cpuminer-multi|minerd)(?:$|\s)/i,
  },
  {
    id: "unm-linux-binary",
    kind: "process_command",
    regex: /(?:^|[\/\s])unm-linux-(?:amd64|arm64)(?:$|\s)/i,
  },
  {
    id: "gpu-miner-binary",
    kind: "process_command",
    regex:
      /(?:^|[\/\s])(?:nanominer|lolminer|teamredminer|t-rex|ccminer)(?:$|\s)/i,
  },
  {
    id: "stratum-url",
    kind: "network_endpoint_argument",
    regex: /stratum\+(?:tcp|ssl|udp):\/\/[^\s'"]+/i,
  },
  {
    id: "known-mining-pool",
    kind: "known_pool_argument",
    regex:
      /\b(?:cereblix|nicehash|unmineable|supportxmr|moneroocean|2miners|nanopool|f2pool|herominers|minexmr|hashvault|ethermine|c3pool)\.[a-z0-9.-]+(?::\d+)?/i,
  },
];

export type KnownPoolAddressMap = Map<string, string>;

export interface ProcNetTcpConnection {
  remote_address: string;
  remote_port: number;
  state: string;
}

type LookupLike = typeof lookup;

let knownPoolAddressCache:
  | {
      expires_at: number;
      addresses: KnownPoolAddressMap;
    }
  | undefined;

function normalizeCommand(command: string): string {
  return command
    .replace(/\0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMMAND_LENGTH);
}

function matchedText(match: RegExpMatchArray): string {
  return `${match[0] ?? ""}`.trim().slice(0, 160);
}

export function detectCryptominingCommand({
  pid,
  command,
}: {
  pid: number;
  command: string;
}): ProjectCryptominingSignal[] {
  const normalized = normalizeCommand(command);
  if (!normalized) return [];
  const signals: ProjectCryptominingSignal[] = [];
  for (const pattern of COMMAND_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    signals.push({
      kind: pattern.kind,
      pattern: pattern.id,
      matched: matchedText(match),
      pid,
      command: normalized,
    });
  }
  return signals;
}

export function buildCryptominingEvidence(
  signals: ProjectCryptominingSignal[],
): ProjectCryptominingEvidence | undefined {
  if (signals.length === 0) return;
  return {
    confidence: "high",
    detector_version: DETECTOR_VERSION,
    detected_at: new Date().toISOString(),
    signals: signals.slice(0, MAX_SIGNALS),
  };
}

function parseIpv4LittleEndianHex(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return;
  const bytes = hex.match(/[0-9a-fA-F]{2}/g);
  if (!bytes) return;
  return bytes
    .reverse()
    .map((byte) => Number.parseInt(byte, 16))
    .join(".");
}

function parseHexPort(hex: string): number | undefined {
  if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return;
  const port = Number.parseInt(hex, 16);
  return Number.isInteger(port) && port >= 0 && port <= 65535
    ? port
    : undefined;
}

export function parseProcNetTcpConnections(
  content: string,
): ProcNetTcpConnection[] {
  const connections: ProcNetTcpConnection[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("sl")) continue;
    const fields = line.split(/\s+/);
    const remote = fields[2];
    const state = `${fields[3] ?? ""}`.trim().toUpperCase();
    if (!remote || !state) continue;
    const [addressHex, portHex] = remote.split(":");
    const remote_address = parseIpv4LittleEndianHex(addressHex ?? "");
    const remote_port = parseHexPort(portHex ?? "");
    if (!remote_address || remote_port == null) continue;
    connections.push({ remote_address, remote_port, state });
  }
  return connections;
}

export async function getKnownMiningPoolAddressMap({
  now = Date.now(),
  lookupFn = lookup,
}: {
  now?: number;
  lookupFn?: LookupLike;
} = {}): Promise<KnownPoolAddressMap> {
  if (knownPoolAddressCache && knownPoolAddressCache.expires_at > now) {
    return knownPoolAddressCache.addresses;
  }
  const addresses: KnownPoolAddressMap = new Map();
  await Promise.all(
    KNOWN_MINING_POOL_HOSTS.map(async (host) => {
      try {
        const results = await lookupFn(host, { all: true });
        for (const result of results) {
          if (result.family === 4) {
            addresses.set(result.address, host);
          }
        }
      } catch {
        // DNS failures should not break CPU accounting or other detectors.
      }
    }),
  );
  knownPoolAddressCache = {
    expires_at: now + KNOWN_POOL_ADDRESS_CACHE_TTL_MS,
    addresses,
  };
  return addresses;
}

export function detectCryptominingNetworkConnections({
  connections,
  knownPoolAddresses,
}: {
  connections: ProcNetTcpConnection[];
  knownPoolAddresses: KnownPoolAddressMap;
}): ProjectCryptominingSignal[] {
  const signals: ProjectCryptominingSignal[] = [];
  const seen = new Set<string>();
  for (const connection of connections) {
    if (connection.state !== "01") continue;
    if (!MINING_POOL_PORTS.has(connection.remote_port)) continue;
    const poolHost = knownPoolAddresses.get(connection.remote_address);
    if (!poolHost) continue;
    const key = `${connection.remote_address}:${connection.remote_port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({
      kind: "network_endpoint",
      pattern: "known-pool-ip-established",
      matched: key,
      remote_address: connection.remote_address,
      remote_port: connection.remote_port,
      pool_host: poolHost,
    });
  }
  return signals;
}

export const __test__ = {
  normalizeCommand,
  parseIpv4LittleEndianHex,
  parseHexPort,
  KNOWN_MINING_POOL_HOSTS,
  MINING_POOL_PORTS,
};
