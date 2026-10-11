/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which queries the getPool(cacheTime) result cache may serve (see cached.ts):
// plain reads only. A query is cacheable if it is a SELECT, VALUES or WITH
// statement that writes nothing, locks nothing and calls only functions known
// to be read-only. Everything else, including any function not on the list
// below, goes straight to the database: when in doubt, don't cache.

// Built-in functions (and keywords written like functions) that only read.
const READ_ONLY_FUNCTIONS = new Set([
  // keywords that take a parenthesized argument
  "all",
  "and",
  "any",
  "array",
  "as",
  "between",
  "by",
  "case",
  "cast",
  "coalesce",
  "distinct",
  "else",
  "exists",
  "filter",
  "from",
  "in",
  "is",
  "join",
  "lateral",
  "like",
  "ilike",
  "not",
  "nullif",
  "on",
  "or",
  "over",
  "row",
  "select",
  "some",
  "then",
  "using",
  "values",
  "when",
  "where",
  "with",
  "within",
  // aggregates and window functions
  "array_agg",
  "avg",
  "bool_and",
  "bool_or",
  "count",
  "dense_rank",
  "every",
  "first_value",
  "json_agg",
  "json_object_agg",
  "jsonb_agg",
  "jsonb_object_agg",
  "lag",
  "last_value",
  "lead",
  "max",
  "min",
  "percentile_cont",
  "percentile_disc",
  "rank",
  "row_number",
  "string_agg",
  "sum",
  // scalar functions
  "abs",
  "age",
  "array_length",
  "array_position",
  "array_remove",
  "array_to_string",
  "btrim",
  "cardinality",
  "ceil",
  "ceiling",
  "char_length",
  "concat",
  "concat_ws",
  "date_part",
  "date_trunc",
  "decode",
  "encode",
  "extract",
  "floor",
  "format",
  "generate_series",
  "greatest",
  "hashtext",
  "json_build_array",
  "json_build_object",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_array_length",
  "jsonb_build_array",
  "jsonb_build_object",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_exists",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_object_keys",
  "jsonb_set",
  "jsonb_strip_nulls",
  "jsonb_typeof",
  "least",
  "left",
  "length",
  "lower",
  "ltrim",
  "make_interval",
  "md5",
  "now",
  "position",
  "regexp_match",
  "regexp_matches",
  "regexp_replace",
  "replace",
  "right",
  "round",
  "row_to_json",
  "rtrim",
  "split_part",
  "starts_with",
  "strpos",
  "substr",
  "substring",
  "timezone",
  "to_char",
  "to_json",
  "to_jsonb",
  "to_timestamp",
  "trim",
  "unnest",
  "upper",
]);

// Statements that write, lock or change state, wherever they appear (a WITH
// can contain an UPDATE).
const WRITES_OR_LOCKS =
  /\b(insert|update|delete|merge|truncate|copy|call|do|lock|notify|listen|vacuum|analyze|refresh|alter|create|drop|grant|revoke|into)\b|\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b/i;

/**
 * The query text with comments removed and every string literal, quoted
 * identifier and dollar-quoted string replaced by a placeholder, in one scan
 * (so that `'--'` is a literal, not a comment). Undefined if the text does
 * not scan, e.g. an unterminated literal.
 */
export function normalizeSql(text: string): string | undefined {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
    } else if (c === "/" && next === "*") {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) return undefined;
      out += " ";
    } else if (c === "'") {
      // E'...' strings also allow backslash escapes.
      const escapes = /[eE]$/.test(out) && !/\w[eE]$/.test(out);
      i += 1;
      for (;;) {
        if (i >= n) return undefined;
        if (escapes && text[i] === "\\") {
          i += 2;
        } else if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          i += 1;
        }
      }
      out += "''";
    } else if (c === '"') {
      i += 1;
      for (;;) {
        if (i >= n) return undefined;
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          i += 1;
        }
      }
      // A quoted identifier: the name of an unknown function, if called.
      out += '"q"';
    } else if (c === "$" && /[A-Za-z_$]/.test(next ?? "")) {
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(i));
      if (tag == null) {
        out += c;
        i += 1;
        continue;
      }
      const end = text.indexOf(tag[0], i + tag[0].length);
      if (end === -1) return undefined;
      i = end + tag[0].length;
      out += "''";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function queryText(args: unknown[]): string | undefined {
  const [first] = args;
  if (typeof first === "string") return first;
  if (first != null && typeof (first as any).text === "string") {
    return (first as any).text;
  }
  return undefined;
}

/** Whether a query may be served from the getPool(cacheTime) cache. */
export function isCacheableQuery(args: unknown[]): boolean {
  const raw = queryText(args);
  if (raw == null) return false;
  const text = normalizeSql(raw)?.trim();
  if (!text || !/^(select|values|with|\()/i.test(text)) return false;
  if (WRITES_OR_LOCKS.test(text)) return false;
  // Every call must be to a function known to only read.
  for (const match of text.matchAll(
    /("q"|[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?)\s*\(/g,
  )) {
    // An alias with a column list, as in "jsonb_each(x) AS e(key, value)".
    if (/\bas\s*$/i.test(text.slice(0, match.index))) continue;
    let name = match[1].toLowerCase().replace(/\s+/g, "");
    if (name.startsWith("pg_catalog.")) name = name.slice("pg_catalog.".length);
    if (!READ_ONLY_FUNCTIONS.has(name)) return false;
  }
  return true;
}
