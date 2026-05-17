/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DANGEROUS_RPC_DECISIONS,
  type DangerousRpcDecision,
} from "./dangerous-rpc-registry";

type SourceModule = {
  filename: string;
  hubGroup: string;
};

const SOURCE_MODULES: SourceModule[] = [
  { filename: "agent.ts", hubGroup: "agent" },
  { filename: "db.ts", hubGroup: "db" },
  { filename: "lro.ts", hubGroup: "lro" },
  { filename: "messages.ts", hubGroup: "messages" },
  { filename: "notifications.ts", hubGroup: "notifications" },
  { filename: "projects.ts", hubGroup: "projects" },
  { filename: "project-backups.ts", hubGroup: "projects" },
  { filename: "project-snapshots.ts", hubGroup: "projects" },
  { filename: "hosts.ts", hubGroup: "hosts" },
  { filename: "system.ts", hubGroup: "system" },
  { filename: "org.ts", hubGroup: "org" },
  { filename: "purchases.ts", hubGroup: "purchases" },
  { filename: "software.ts", hubGroup: "software" },
  { filename: "sync.ts", hubGroup: "sync" },
];

const RISKY_EXPORT_PATTERN =
  /^export\s+(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)\s*=\s*(?:reuseInFlight\()?/gm;

const DANGEROUS_RPC_NAME_PATTERN =
  /^(?:add|admin|archive|assign|begin|cancel|claim|clear|cleanup|create|delete|dismiss|drain|finalize|force|gc|hard|issue|leave|mark|move|publish|pull|purchase|purge|reconcile|record|release|remove|repair|request|reserve|restart|restore|rehome|revoke|rollout|run|save|scan|send|set|start|stop|sync|terminate|update|upgrade|upsert)/i;

function exportedNames(source: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = RISKY_EXPORT_PATTERN.exec(source)) != null) {
    names.push(match[1] ?? match[2]);
  }
  return names.filter(Boolean).sort();
}

function riskyHubRpcNames(): string[] {
  const names: string[] = [];
  for (const { filename, hubGroup } of SOURCE_MODULES) {
    const source = readFileSync(join(__dirname, filename), "utf8");
    for (const name of exportedNames(source)) {
      if (DANGEROUS_RPC_NAME_PATTERN.test(name)) {
        names.push(`${hubGroup}.${name}`);
      }
    }
  }
  return Array.from(new Set(names)).sort();
}

function assertDecision(value: DangerousRpcDecision | undefined): void {
  expect(value).toBeDefined();
  expect(value?.decision).toMatch(
    /^(fresh-auth-required|fresh-auth-not-required|internal-auth-only)$/,
  );
  expect(value?.reason.trim()).toBeTruthy();
}

describe("dangerous hub RPC fresh-auth registry", () => {
  it("classifies every risky-looking public hub RPC export", () => {
    const riskyNames = riskyHubRpcNames();
    const missing = riskyNames.filter((name) => !DANGEROUS_RPC_DECISIONS[name]);

    expect(missing).toEqual([]);
    for (const name of riskyNames) {
      assertDecision(DANGEROUS_RPC_DECISIONS[name]);
    }
  });

  it("does not contain stale RPC names", () => {
    const riskyNames = new Set(riskyHubRpcNames());
    const stale = Object.keys(DANGEROUS_RPC_DECISIONS).filter(
      (name) => !riskyNames.has(name),
    );

    expect(stale).toEqual([]);
  });
});
