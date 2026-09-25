/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { ClaudeSubscriptionLoginService } from "./claude-subscription-login";
import { publishClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { reapAbandonedClaudeLogins } from "./claude-login-cleanup";
import getLogger from "@cocalc/backend/logger";

let service: ClaudeSubscriptionLoginService | undefined;
let closing = false;

export async function closeClaudeSubscriptionLoginService(): Promise<void> {
  closing = true;
  await service?.close();
}

export function startClaudeLoginReaper(): () => void {
  const logger = getLogger("project-host:claude-login-cleanup");
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await reapAbandonedClaudeLogins();
    } catch {
      logger.warn("Claude sign-in cleanup requires retry");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), 30_000);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}

function managedClaudeCliPath(): string {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw Error("Claude subscription login is not available on this host");
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const variant = report?.header?.glibcVersionRuntime ? "" : "-musl";
  const root = process.env.COCALC_MANAGED_HARNESSES ?? "/opt/cocalc/harnesses";
  return `${root}/claude-code/${CLAUDE_CODE_QUALIFICATION.package.version}/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}${variant}/claude`;
}

export async function getClaudeSubscriptionLoginService(): Promise<ClaudeSubscriptionLoginService> {
  if (closing) throw Error("Claude sign-in service is closing");
  if (service) return service;
  const cliPath = managedClaudeCliPath();
  await access(cliPath, constants.X_OK);
  if (closing) throw Error("Claude sign-in service is closing");
  return (service ??= new ClaudeSubscriptionLoginService({
    cliPath,
    publish: publishClaudeSubscriptionCredential,
  }));
}
