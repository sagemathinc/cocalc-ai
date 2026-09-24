/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { ClaudeSubscriptionLoginService } from "./claude-subscription-login";
import { publishClaudeSubscriptionCredential } from "./claude-subscription-registry";

let service: ClaudeSubscriptionLoginService | undefined;

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
  if (service) return service;
  const cliPath = managedClaudeCliPath();
  await access(cliPath, constants.X_OK);
  return (service ??= new ClaudeSubscriptionLoginService({
    cliPath,
    publish: publishClaudeSubscriptionCredential,
  }));
}
