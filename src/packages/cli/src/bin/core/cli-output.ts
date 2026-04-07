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

const DEFAULT_TABLE_WIDTH = 120;
const MIN_TABLE_CELL_WIDTH = 12;
const MAX_AUTO_CELL_WIDTH = 48;
const MAX_KEY_COLUMN_WIDTH = 24;
const TABLE_BORDER_OVERHEAD = 10;

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function targetTableWidth(): number {
  const width = Number(process.stdout?.columns ?? 0);
  if (Number.isFinite(width) && width >= 40) {
    return Math.floor(width);
  }
  return DEFAULT_TABLE_WIDTH;
}

function wrapCellText(value: string, width: number): string[] {
  if (!(width > 0) || value.length <= width) {
    return value === "" ? [""] : value.split(/\r?\n/);
  }
  const out: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(" ", width);
      if (splitAt <= 0 || splitAt < Math.floor(width * 0.6)) {
        splitAt = width;
      }
      out.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    out.push(remaining);
  }
  return out;
}

function addWrappedRow({
  table,
  cells,
  widths,
  blankContinuationColumns = new Set<number>(),
}: {
  table: AsciiTable3;
  cells: string[];
  widths: number[];
  blankContinuationColumns?: Set<number>;
}): void {
  const wrapped = cells.map((cell, i) => wrapCellText(cell, widths[i]));
  const lineCount = wrapped.reduce(
    (max, lines) => Math.max(max, lines.length),
    1,
  );
  for (let line = 0; line < lineCount; line += 1) {
    table.addRow(
      ...wrapped.map((lines, i) =>
        line > 0 && blankContinuationColumns.has(i) ? "" : (lines[line] ?? ""),
      ),
    );
  }
}

function computeArrayColumnWidths(
  cols: string[],
  rows: Record<string, unknown>[],
): number[] {
  const available = Math.max(
    cols.length * MIN_TABLE_CELL_WIDTH,
    targetTableWidth() - (cols.length * 3 + 4),
  );
  const natural = cols.map((col) =>
    Math.max(
      col.length,
      ...rows.map((row) =>
        formatValue(row[col])
          .split(/\r?\n/)
          .reduce((max, line) => Math.max(max, line.length), 0),
      ),
    ),
  );
  if (natural.reduce((sum, width) => sum + width, 0) <= available) {
    return natural;
  }
  const widths = natural.map((width) =>
    Math.max(MIN_TABLE_CELL_WIDTH, Math.min(width, MAX_AUTO_CELL_WIDTH)),
  );
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    let widest = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[widest]) {
        widest = i;
      }
    }
    if (widths[widest] <= MIN_TABLE_CELL_WIDTH) {
      break;
    }
    widths[widest] -= 1;
  }
  return widths;
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
  const widths = computeArrayColumnWidths(cols, rows);
  for (const row of rows) {
    addWrappedRow({
      table,
      cells: cols.map((col) => formatValue(row[col])),
      widths,
    });
  }
  console.log(table.toString());
}

function printKeyValueTable(data: Record<string, unknown>): void {
  const table = new AsciiTable3("Result");
  table.setStyle("unicode-round");
  table.setHeading("Field", "Value");
  const keyWidth = Math.min(
    MAX_KEY_COLUMN_WIDTH,
    Math.max(5, ...Object.keys(data).map((key) => key.length)),
  );
  const valueWidth = Math.max(
    20,
    targetTableWidth() - keyWidth - TABLE_BORDER_OVERHEAD,
  );
  for (const [key, value] of Object.entries(data)) {
    addWrappedRow({
      table,
      cells: [key, formatValue(value)],
      widths: [keyWidth, valueWidth],
      blankContinuationColumns: new Set([0]),
    });
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
  const accountId =
    ctx.accountId ?? ctx.globals?.accountId ?? ctx.globals?.account_id;

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
