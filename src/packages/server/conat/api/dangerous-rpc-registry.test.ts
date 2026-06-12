/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
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
  { filename: "admin-data-explorer.ts", hubGroup: "adminData" },
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
  /^(?:add|admin|apply|archive|assign|begin|bootstrap|cancel|claim|clear|cleanup|create|delete|dismiss|drain|finalize|force|gc|generate|hard|issue|leave|mark|move|prune|publish|pull|purchase|purge|reconcile|record|release|remove|repair|request|reserve|restart|restore|rehome|review|revoke|rollout|run|save|scan|send|set|start|stop|sync|terminate|update|upgrade|upsert)/i;

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

function frontendSourceFiles(dir = join(__dirname, "../../../frontend")) {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".next" ||
        entry === "__tests__" ||
        entry === "test"
      ) {
        continue;
      }
      files.push(...frontendSourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function findMatchingParen(source: string, openParen: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function frontendFreshAuthProofOmissions(): string[] {
  const freshAuthRequired = Object.entries(DANGEROUS_RPC_DECISIONS)
    .filter(([, decision]) => decision.decision === "fresh-auth-required")
    .map(([name]) => name)
    .sort();
  const omissions: string[] = [];
  for (const filename of frontendSourceFiles()) {
    const source = readFileSync(filename, "utf8");
    for (const name of freshAuthRequired) {
      const [group, method] = name.split(".");
      const pattern = new RegExp(`\\.hub\\.${group}\\.${method}\\s*\\(`, "g");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) != null) {
        const openParen = match.index + match[0].length - 1;
        const closeParen = findMatchingParen(source, openParen);
        const args =
          closeParen >= 0
            ? source.slice(openParen + 1, closeParen)
            : source.slice(openParen + 1, openParen + 1000);
        if (/\b(browser_id|session_hash)\s*:/.test(args)) {
          continue;
        }
        omissions.push(
          `${filename}:${lineNumber(source, match.index)} ${name} lacks browser_id/session_hash`,
        );
      }
    }
  }
  return omissions;
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

  it("requires frontend direct calls to fresh-auth RPCs to pass browser/session proof", () => {
    expect(frontendFreshAuthProofOmissions()).toEqual([]);
  });
});
