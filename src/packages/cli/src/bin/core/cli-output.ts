/**
 * CLI output and error rendering helpers.
 *
 * This module keeps table/json rendering and error formatting consistent across
 * commands while preserving machine-readable output contracts.
 */
import { AsciiTable3 } from "ascii-table3";

type OutputGlobals = {
  json?: boolean;
  output?: "table" | "json" | "yaml";
  quiet?: boolean;
  api?: string;
  accountId?: string;
  account_id?: string;
};

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  return value as Record<string, unknown>;
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function printArrayTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const cols = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  const table = new AsciiTable3("Result");
  table.setStyle("unicode-round");
  table.setHeading(...cols);
  for (const row of rows) {
    table.addRow(...cols.map((col) => formatValue(row[col])));
  }
  console.log(table.toString());
}

function printKeyValueTable(data: Record<string, unknown>): void {
  const table = new AsciiTable3("Result");
  table.setStyle("unicode-round");
  table.setHeading("Field", "Value");
  for (const [key, value] of Object.entries(data)) {
    table.addRow(key, formatValue(value));
  }
  console.log(table.toString());
}

export function emitSuccess(
  ctx: { globals: OutputGlobals; apiBaseUrl?: string; accountId?: string },
  commandName: string,
  data: unknown,
): void {
  if (ctx.globals.json || ctx.globals.output === "json") {
    const payload = {
      ok: true,
      command: commandName,
      data,
      meta: {
        api: ctx.apiBaseUrl ?? null,
        account_id: ctx.accountId ?? null,
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (ctx.globals.quiet) {
    return;
  }

  if (
    Array.isArray(data) &&
    data.every((x) => x && typeof x === "object" && !Array.isArray(x))
  ) {
    printArrayTable(data as Record<string, unknown>[]);
    return;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    printKeyValueTable(asObject(data));
    return;
  }
  if (data != null) {
    console.log(String(data));
  }
}

export function emitError(
  ctx: { globals?: OutputGlobals; apiBaseUrl?: string; accountId?: string },
  commandName: string,
  error: unknown,
  normalizeUrl: (url: string) => string,
): void {
  const message = error instanceof Error ? error.message : `${error}`;
  let api = ctx.apiBaseUrl;
  if (!api && ctx.globals?.api) {
    try {
      api = normalizeUrl(ctx.globals.api);
    } catch {
      api = ctx.globals.api;
    }
  }
  const accountId = ctx.accountId ?? ctx.globals?.accountId ?? ctx.globals?.account_id;

  if (ctx.globals?.json || ctx.globals?.output === "json") {
    const payload = {
      ok: false,
      command: commandName,
      error: {
        code: "command_failed",
        message,
      },
      meta: {
        api,
        account_id: accountId,
      },
    };
    console.error(JSON.stringify(payload, null, 2));
    return;
  }
  console.error(`ERROR: ${message}`);
}
