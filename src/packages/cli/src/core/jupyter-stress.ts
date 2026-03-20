import { createHash } from "node:crypto";

export type JupyterStressPreset = "smoke" | "stress";

export const JUPYTER_STRESS_PRESET_CODE: Record<JupyterStressPreset, string> = {
  smoke: 'for i in range(1000): print(i, end=" ")',
  stress: 'for i in range(10000): print(i, end=" ")',
};

export type OutputSummary = {
  present: boolean;
  entries: number;
  bytes: number;
  signature: string | null;
  has_null_entry: boolean;
};

export type StressInvariantInput = {
  prev_exec_count: number | null;
  next_exec_count: number | null;
  runtime_state: string | null | undefined;
  output_after: OutputSummary;
  output_after_settle: OutputSummary;
};

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function resolveJupyterStressCode(opts: {
  preset?: JupyterStressPreset;
  code?: string;
}): string {
  const explicit = `${opts.code ?? ""}`.trim();
  if (explicit) {
    return explicit;
  }
  return JUPYTER_STRESS_PRESET_CODE[opts.preset ?? "stress"];
}

export function normalizeExecCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

export function summarizeOutput(value: unknown): OutputSummary {
  if (value == null) {
    return {
      present: false,
      entries: 0,
      bytes: 0,
      signature: null,
      has_null_entry: false,
    };
  }
  const plain = value as any;
  const entries = Array.isArray(plain)
    ? plain.length
    : typeof plain === "object"
      ? Object.keys(plain).length
      : 1;
  const hasNullEntry = Array.isArray(plain)
    ? plain.some((entry) => entry == null)
    : typeof plain === "object"
      ? Object.values(plain).some((entry) => entry == null)
      : false;
  const json = stableJson(plain);
  return {
    present: entries > 0,
    entries,
    bytes: Buffer.byteLength(json, "utf8"),
    signature: createHash("sha1").update(json).digest("hex"),
    has_null_entry: hasNullEntry,
  };
}

export function evaluateStressRunInvariants(
  input: StressInvariantInput,
): string[] {
  const errors: string[] = [];
  const { prev_exec_count, next_exec_count, runtime_state } = input;
  if (next_exec_count == null) {
    errors.push("execution_count is null");
  } else if (next_exec_count === 0) {
    errors.push("execution_count is 0");
  } else if (prev_exec_count != null) {
    if (next_exec_count !== prev_exec_count + 1) {
      errors.push(
        `execution_count ${next_exec_count} is not previous + 1 (${prev_exec_count + 1})`,
      );
    }
  } else if (next_exec_count <= 0) {
    errors.push(`execution_count ${next_exec_count} must be positive`);
  }

  if (runtime_state !== "done") {
    errors.push(
      `runtime state is '${runtime_state ?? "null"}', expected 'done'`,
    );
  }

  if (!input.output_after.present) {
    errors.push("output missing after completion");
  }
  if (input.output_after.has_null_entry) {
    errors.push("output contains null entries after completion");
  }
  if (!input.output_after_settle.present) {
    errors.push("output missing after settle");
  }
  if (input.output_after_settle.has_null_entry) {
    errors.push("output contains null entries after settle");
  }
  if (
    input.output_after.present &&
    input.output_after_settle.present &&
    input.output_after.signature !== input.output_after_settle.signature
  ) {
    errors.push("output changed after settle");
  }
  return errors;
}
