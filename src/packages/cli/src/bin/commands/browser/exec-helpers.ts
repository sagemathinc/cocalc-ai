/*
Exec and policy helpers for browser command flows.
*/

import { readFile } from "node:fs/promises";
import type {
  BrowserAutomationPosture,
  BrowserExecPolicyV1,
} from "@cocalc/conat/service/browser-session";
import {
  defaultPostureForApiUrl,
  normalizeBrowserPosture,
  parseBrowserExecPolicy,
} from "./parse-format";
import type {
  BrowserExecOperation,
  BrowserSessionClient,
} from "./types";

export async function resolveBrowserPolicyAndPosture({
  posture,
  policyFile,
  allowRawExec,
  apiBaseUrl,
}: {
  posture?: string;
  policyFile?: string;
  allowRawExec?: boolean;
  apiBaseUrl?: string;
}): Promise<{
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}> {
  const resolvedPosture =
    normalizeBrowserPosture(posture) ??
    normalizeBrowserPosture(process.env.COCALC_BROWSER_POSTURE) ??
    defaultPostureForApiUrl(`${apiBaseUrl ?? ""}`);
  let policy: BrowserExecPolicyV1 | undefined;
  const cleanPolicyFile = `${policyFile ?? ""}`.trim();
  if (cleanPolicyFile) {
    const policyRaw = await readFile(cleanPolicyFile, "utf8");
    policy = parseBrowserExecPolicy(policyRaw);
  }
  if (allowRawExec) {
    policy = {
      ...(policy ?? { version: 1 }),
      version: 1,
      allow_raw_exec: true,
    };
  }
  return { posture: resolvedPosture, ...(policy ? { policy } : {}) };
}

export function withBrowserExecStaleSessionHint({
  err,
  posture,
  policy,
  browserId,
}: {
  err: unknown;
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
  browserId?: string;
}): Error {
  const base = err instanceof Error ? err.message : `${err}`;
  const msg = `${base ?? ""}`;
  const quickjsExpected = posture === "prod" && !policy?.allow_raw_exec;
  if (
    quickjsExpected &&
    (msg.includes("raw browser exec is blocked in prod posture") ||
      msg.includes("QuickJSUseAfterFree"))
  ) {
    const reloadCmd = browserId
      ? `cocalc browser action reload --browser ${browserId} --posture prod`
      : "cocalc browser action reload --posture prod";
    return new Error(
      `${msg}\n\nThis browser session is likely stale after a frontend rebuild. Reload the target session and retry.\nTry: ${reloadCmd}\nIf needed, use --hard or manually hard-refresh the tab.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export function isExecTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export async function waitForExecOperation({
  browserClient,
  exec_id,
  pollMs,
  timeoutMs,
}: {
  browserClient: BrowserSessionClient;
  exec_id: string;
  pollMs: number;
  timeoutMs: number;
}): Promise<BrowserExecOperation> {
  const started = Date.now();
  for (;;) {
    const op = await browserClient.getExec({ exec_id });
    if (isExecTerminal(op.status)) {
      return op;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for browser exec ${exec_id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function readExecScriptFromStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
