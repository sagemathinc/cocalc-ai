import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("ai:acp:harness-diagnostics");
const LIMIT = 16 * 1024;

// Only fixed diagnostic vocabulary survives. Regex secret removal alone cannot
// safely retain arbitrary provider messages, prompts, tool output, or stderr.
const SIGNALS = {
  rate_limit: /rate.?limit|too many requests/i,
  overloaded: /overloaded|overload_error/i,
  authentication:
    /authentication|unauthorized|invalid.?api.?key|token expired/i,
  permission: /permission denied|forbidden/i,
  context_limit: /context.{0,24}(?:limit|length)|prompt is too long/i,
  out_of_memory: /out of memory|heap limit|heap exhaustion/i,
  timeout: /timed? ?out|timeout/i,
  connection_reset: /ECONNRESET|connection reset/i,
  connection_refused: /ECONNREFUSED/i,
  dns: /ENOTFOUND|EAI_AGAIN/i,
  disk_full: /ENOSPC|no space left/i,
  missing_file: /ENOENT|no such file/i,
  process_exit: /process exited|process exit|ACP process closed/i,
  transport_closed: /connection closed|stdin closed|runtime unavailable/i,
  invalid_json: /invalid json|unexpected token|JSON parse/i,
  execution_error: /error_during_execution/i,
  max_turns: /error_max_turns/i,
  budget: /error_max_budget_usd|budget exceeded/i,
  cancelled: /aborterror|cancelled|canceled|SIGTERM/i,
  killed: /SIGKILL/i,
  internal_error: /internal error|internal_error/i,
  type_error: /\bTypeError\b/,
  range_error: /\bRangeError\b/,
  syntax_error: /\bSyntaxError\b/,
} as const;

type Signal = keyof typeof SIGNALS;

function signals(text: string): Signal[] {
  return (Object.keys(SIGNALS) as Signal[]).filter((key) =>
    SIGNALS[key].test(text),
  );
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return;
  // Do not execute getters, toJSON, custom inspection, or stringify raw errors.
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return;
  }
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

export function diagnosticError(error: unknown) {
  const found = new Set<Signal>();
  const codes = new Set<number>();
  const statuses = new Set<number>();
  const exits = new Set<number>();
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  let textBytes = 0;
  for (let i = 0; i < queue.length && i < 16; i++) {
    const value = queue[i];
    if (seen.has(value)) continue;
    seen.add(value);
    const code = own(value, "code");
    if (
      Number.isInteger(code) &&
      Number(code) >= -32768 &&
      Number(code) <= -32000
    )
      codes.add(Number(code));
    for (const key of ["status", "statusCode"]) {
      const status = own(value, key);
      if (
        Number.isInteger(status) &&
        Number(status) >= 400 &&
        Number(status) <= 599
      )
        statuses.add(Number(status));
    }
    const parts =
      typeof value === "string"
        ? [value]
        : [
            own(value, "message"),
            own(value, "name"),
            code,
            own(value, "type"),
            own(value, "subtype"),
          ];
    for (const part of parts) {
      if (typeof part !== "string" || textBytes >= LIMIT) continue;
      const text = part.slice(0, LIMIT - textBytes);
      textBytes += text.length;
      for (const signal of signals(text)) found.add(signal);
      for (const match of text.matchAll(
        /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*([45]\d{2})\b/gi,
      ))
        statuses.add(Number(match[1]));
      for (const match of text.matchAll(
        /\bprocess exited with code (\d{1,3})\b/gi,
      )) {
        if (Number(match[1]) <= 255) exits.add(Number(match[1]));
      }
    }
    for (const key of ["cause", "data", "error"]) {
      const child = own(value, key);
      if (child != null) queue.push(child);
    }
  }
  return {
    signals: [...found],
    protocol_codes: [...codes],
    http_statuses: [...statuses],
    reported_exit_codes: [...exits],
  };
}

/** Bounded, process-local tail. Raw bytes are never emitted or written to disk. */
export class HarnessStderrDiagnostics {
  private tail = Buffer.alloc(0);
  private bytes = 0;
  private summary?: ReturnType<HarnessStderrDiagnostics["snapshot"]>;

  append(chunk: Buffer | string): void {
    if (this.summary) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes = Math.min(Number.MAX_SAFE_INTEGER, this.bytes + data.length);
    this.tail = Buffer.from(
      Buffer.concat([
        this.tail.subarray(
          Math.max(0, this.tail.length - LIMIT + Math.min(data.length, LIMIT)),
        ),
        data.subarray(Math.max(0, data.length - LIMIT)),
      ]),
    );
  }

  snapshot(): {
    bytes: number;
    truncated: boolean;
    signals: Signal[];
    http_statuses: number[];
    reported_exit_codes: number[];
  } {
    const parsed = diagnosticError(this.tail.toString("utf8"));
    return (
      this.summary ?? {
        bytes: this.bytes,
        truncated: this.bytes > this.tail.length,
        signals: parsed.signals,
        http_statuses: parsed.http_statuses,
        reported_exit_codes: parsed.reported_exit_codes,
      }
    );
  }

  seal(): void {
    this.summary = this.snapshot();
    this.tail.fill(0);
    this.tail = Buffer.alloc(0);
  }
}

export function recordHarnessDiagnostic(input: {
  method: string;
  projectId: string;
  accountId: string;
  sessionId?: string;
  elapsedMs: number;
  protocolRejection: boolean;
  error: unknown;
  failure?: unknown;
  stderr: HarnessStderrDiagnostics;
}): string {
  const id = randomUUID();
  try {
    // JSON keeps the complete bounded record on one searchable operator-log line.
    logger.warn(
      "ACP failure diagnostic",
      JSON.stringify({
        schema_version: 1,
        diagnostic_id: id,
        timestamp: new Date().toISOString(),
        project_id: uuid(input.projectId),
        account_id: uuid(input.accountId),
        session_id: uuid(input.sessionId),
        method: input.method,
        elapsed_ms: input.elapsedMs,
        protocol_rejection: input.protocolRejection,
        error: diagnosticError(input.error),
        failure: diagnosticError(input.failure),
        stderr: input.stderr.snapshot(),
      }),
    );
  } catch {
    // Diagnostics must not prevent cleanup or change retry/delivery semantics.
  }
  input.stderr.seal();
  return id;
}
