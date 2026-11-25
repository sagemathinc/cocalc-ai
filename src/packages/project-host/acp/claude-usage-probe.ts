/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
A fresh reading of a Claude subscription's limits, for one whose last reading
is old (the home bay asks; server/agents/claude-usage-probe.ts). Claude only
reports a subscription's limits with a model response, and CoCalc's tokens
(from `claude setup-token`) cannot read the usage endpoint, so this asks
Claude Code for a one-word Haiku reply: no tools, no settings, hooks or MCP
servers, in an empty home that is removed afterwards. Claude Code prints the
limits as a rate_limit_event, which is saved like a turn's.
*/

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  claudeRateLimitSnapshot,
  type ClaudeRateLimitSnapshot,
} from "@cocalc/util/ai/claude-usage";
import { isValidUUID } from "@cocalc/util/misc";
import { claudeCodeCliPath } from "./claude-code-tools";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { claudeSubscriptionToken } from "./claude-subscription-token";
import { writeClaudeUsageToHomeBay } from "./claude-subscription-usage";

const logger = getLogger("project-host:acp:claude-usage-probe");

const PROBE_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
// Probes are rare (one per subscription every few hours); never many at once.
const MAX_CONCURRENT = 2;

export const CLAUDE_USAGE_PROBE_PROMPT = "Reply with the single word: ok";

/** Claude Code's arguments: one turn, no tools or customizations. */
export function claudeUsageProbeArgs(): string[] {
  return [
    "-p",
    "--model",
    "haiku",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    CLAUDE_USAGE_PROBE_PROMPT,
  ];
}

/** The limits in Claude Code's stream-json output: the last report of each
 * window. Undefined when it reported none (e.g. it failed before a request). */
export function claudeUsageFromProbeOutput(
  output: string,
  now = Date.now(),
): ClaudeRateLimitSnapshot | undefined {
  let result: ClaudeRateLimitSnapshot | undefined;
  for (const line of output.split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "rate_limit_event") continue;
    const snapshot = claudeRateLimitSnapshot(event.rate_limit_info, now);
    if (!snapshot) continue;
    result = {
      observed_at: snapshot.observed_at,
      windows: { ...result?.windows, ...snapshot.windows },
    };
  }
  return result;
}

/** What went wrong, from Claude Code's result line, without the output. */
function probeError(output: string): string | undefined {
  for (const line of output.split("\n").reverse()) {
    if (!line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "result" && event.is_error)
        return `${event.subtype ?? "error"}: ${`${event.result ?? ""}`.slice(0, 200)}`;
    } catch {}
  }
}

type RunClaude = (options: {
  cliPath: string;
  args: string[];
  token: string;
  home: string;
  timeoutMs: number;
}) => Promise<string>;

const runClaude: RunClaude = ({ cliPath, args, token, home, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: home,
        CLAUDE_CONFIG_DIR: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        CLAUDE_CODE_OAUTH_TOKEN: token,
        // Only the model request: no telemetry, updates or other fetches.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES)
        output += chunk
          .toString("utf8")
          .slice(0, MAX_OUTPUT_BYTES - output.length);
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      kill();
      reject(Error("Claude Code did not finish in time"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Nothing it started may outlive it.
      kill();
      resolve(output);
    });
  });

export interface ClaudeUsageProbeDeps {
  getToken: (options: {
    projectId: string;
    accountId: string;
    credentialId: string;
  }) => Promise<string>;
  cliPath: () => Promise<string>;
  run: RunClaude;
  save: (options: {
    projectId: string;
    accountId: string;
    credentialId: string;
    usage: ClaudeRateLimitSnapshot;
  }) => Promise<void>;
  timeoutMs: number;
}

const defaultDeps: ClaudeUsageProbeDeps = {
  async getToken(options) {
    const { payload } = await getClaudeSubscriptionCredential(options);
    const token = claudeSubscriptionToken(payload);
    if (!token)
      throw Error(
        "this subscription was connected the old way; reconnect it to check its limits",
      );
    return token;
  },
  cliPath: claudeCodeCliPath,
  run: runClaude,
  save: writeClaudeUsageToHomeBay,
  timeoutMs: PROBE_TIMEOUT_MS,
};

/**
 * Check a subscription's limits now and save them to its credential
 * metadata. Returns when the reading was taken; throws if Claude reported
 * none. One check per subscription at a time.
 */
export function createClaudeUsageProbe(
  deps: Partial<ClaudeUsageProbeDeps> = {},
) {
  const { getToken, cliPath, run, save, timeoutMs } = {
    ...defaultDeps,
    ...deps,
  };
  const inflight = new Map<string, Promise<{ observed_at: string }>>();
  const probe = async (options: {
    projectId: string;
    accountId: string;
    credentialId: string;
  }): Promise<{ observed_at: string }> => {
    const token = await getToken(options);
    const home = await mkdtemp(join(tmpdir(), "cocalc-claude-probe-"));
    try {
      const output = await run({
        cliPath: await cliPath(),
        args: claudeUsageProbeArgs(),
        token,
        home,
        timeoutMs,
      });
      const usage = claudeUsageFromProbeOutput(output);
      if (!usage)
        throw Error(probeError(output) ?? "Claude reported no limits");
      await save({ ...options, usage });
      return { observed_at: usage.observed_at };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  return async (options: {
    projectId: string;
    accountId: string;
    credentialId: string;
  }): Promise<{ observed_at: string }> => {
    const { projectId, accountId, credentialId } = options;
    if (
      !isValidUUID(projectId) ||
      !isValidUUID(accountId) ||
      !isValidUUID(credentialId)
    )
      throw Error("invalid Claude usage check");
    const key = `${accountId}/${credentialId}`;
    const running = inflight.get(key);
    if (running) return await running;
    if (inflight.size >= MAX_CONCURRENT)
      throw Error("other Claude usage checks are running; try again later");
    const promise = probe(options);
    inflight.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      logger.debug("Claude usage check failed", { error: `${error}` });
      throw error;
    } finally {
      inflight.delete(key);
    }
  };
}

let defaultProbe: ReturnType<typeof createClaudeUsageProbe> | undefined;

export async function probeClaudeSubscriptionUsage(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
}): Promise<{ observed_at: string }> {
  defaultProbe ??= createClaudeUsageProbe();
  return await defaultProbe(options);
}
