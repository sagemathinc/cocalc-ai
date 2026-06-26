/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ProjectCryptominingEvidence,
  ProjectCryptominingSignal,
} from "@cocalc/conat/hub/api/system";

const DETECTOR_VERSION = "project-host-cryptomining-v1";
const MAX_COMMAND_LENGTH = 500;
const MAX_SIGNALS = 8;

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

export const __test__ = {
  normalizeCommand,
};
