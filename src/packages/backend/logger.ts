/*
Debug logger for any node.js server.

There is used both by the hub(s) and project(s).

This is an implementation of basically how winston works for us,
but using the vastly simpler super-popular debug module.
*/

// setting env var must come *BEFORE* debug is loaded the first time
process.env.DEBUG_HIDE_DATE = "yes"; // since we supply it ourselves
// otherwise, maybe stuff like this works: (debug as any).inspectOpts["hideDate"] = true;

import debug, { Debugger } from "debug";
import { mkdirSync, createWriteStream, statSync, ftruncate } from "fs";
import { format, inspect } from "util";
import { dirname, join } from "path";
import { logs } from "./data";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

const COCALC = debug("cocalc");

let _trimLogFileSizePath = "";
function isTestRuntime(): boolean {
  const globals = globalThis as Record<string, unknown>;
  return (
    process.env.SMC_TEST != null ||
    process.env.COCALC_TEST_MODE != null ||
    process.env.NODE_ENV === "test" ||
    process.env.JEST_WORKER_ID != null ||
    process.argv.some((arg) => arg.includes("jest")) ||
    globals.jest != null ||
    (globals.expect != null && globals.describe != null)
  );
}

export function trimLogFileSize() {
  // THIS JUST DOESN'T REALLY WORK!
  return;

  if (!_trimLogFileSizePath) return;
  let stats;
  try {
    stats = statSync(_trimLogFileSizePath);
  } catch (_) {
    // this happens if the file doesn't exist, which is fine since "trimming" it would be a no-op
    return;
  }
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    const fileStream = createWriteStream(_trimLogFileSizePath, { flags: "r+" });
    fileStream.on("open", (fd) => {
      ftruncate(fd, MAX_FILE_SIZE_BYTES, (truncateErr) => {
        if (truncateErr) {
          console.error(truncateErr);
          return;
        }
        fileStream.close();
      });
    });
  }
}

// Errors are logged through a strict allowlist. Library errors can carry
// sensitive enumerable fields: Stripe's signature verification error has the
// webhook's Stripe-Signature header and raw body (`header`, `payload`), and
// other SDK errors carry `raw` responses and request headers. With warn/error
// logging on in production (journald), none of that may be written.
const SAFE_ERROR_FIELDS = [
  "name",
  "message",
  "code",
  "status",
  "statusCode",
  "type",
  "requestId",
  "request_id",
  "errno",
  "syscall",
] as const;
const MAX_SANITIZE_DEPTH = 6;

// Never returns an original object that could hold an Error: repeated
// references and cycles reuse the sanitized clone, and anything deeper than
// the limit becomes a marker string.
export function sanitizeForLog(
  value: unknown,
  depth = 0,
  clones: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value == null || typeof value != "object") return value;
  if (clones.has(value)) return clones.get(value);
  if (value instanceof Error) {
    const safe: Record<string, unknown> = {};
    clones.set(value, safe);
    for (const key of SAFE_ERROR_FIELDS) {
      const field = (value as any)[key];
      if (field != null && typeof field != "object") safe[key] = field;
    }
    if (value.stack) safe.stack = value.stack;
    if ((value as any).cause != null) {
      safe.cause = sanitizeForLog((value as any).cause, depth + 1, clones);
    }
    return safe;
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    !Array.isArray(value)
  ) {
    return value; // Buffers, Maps, dates, class instances: as before
  }
  if (depth >= MAX_SANITIZE_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    clones.set(value, out);
    for (const x of value) out.push(sanitizeForLog(x, depth + 1, clones));
    return out;
  }
  const out: Record<string, unknown> = {};
  clones.set(value, out);
  for (const [key, x] of Object.entries(value)) {
    out[key] = sanitizeForLog(x, depth + 1, clones);
  }
  return out;
}

export function myFormat(...rawArgs): string {
  const args = rawArgs.map((x) => sanitizeForLog(x));
  if (args.length > 1 && typeof args[0] == "string" && !args[0].includes("%")) {
    const v: string[] = [];
    for (const x of args) {
      try {
        // Use util.inspect for better object representation
        v.push(
          typeof x == "object"
            ? inspect(x, { depth: 4, breakLength: 120 })
            : `${x}`,
        );
      } catch (_) {
        v.push(`${x}`);
      }
    }
    return v.join(" ");
  }
  return format(...args);
}

function defaultTransports(): { console?: boolean; file?: string } {
  if (isTestRuntime()) {
    return {};
  } else if (process.env.NODE_ENV == "production") {
    return { console: true };
  } else {
    return { file: join(logs, "log") };
  }
}

function initTransports() {
  if (!process.env.DEBUG) {
    // console.log("DEBUG is not set, so not setting up debug logging transport");
    return;
  }
  const transports = defaultTransports();
  if (!isTestRuntime()) {
    if (process.env.DEBUG_CONSOLE) {
      transports.console =
        process.env.DEBUG_CONSOLE != "no" &&
        process.env.DEBUG_CONSOLE != "false";
    }
    if (process.env.DEBUG_FILE != null) {
      transports.file = process.env.DEBUG_FILE;
    }
  }
  let fileStream;
  if (transports.file) {
    const { file } = transports;
    // ensure directory exists
    mkdirSync(dirname(file), { recursive: true });
    // create the file stream; using a stream ensures
    // that everything is written in the right order with
    // no corruption/collision between different logging.
    // We use append mode because we mainly watch the file log
    // when doing dev, and nextjs constantly restarts the process.
    fileStream = createWriteStream(file, {
      flags: "a",
    });
    fileStream.on("error", (err) => {
      if (transports.console && !isTestRuntime()) {
        console.warn(`CoCalc debug file logging disabled for "${file}":`, err);
      }
      transports.file = undefined;
      fileStream = undefined;
    });
    _trimLogFileSizePath = file;
    trimLogFileSize();
  }
  let firstLog: boolean = true;
  COCALC.log = (...args) => {
    if (isTestRuntime()) return;
    if (!transports.file && !transports.console) return;
    if (firstLog && transports.file) {
      const announce = `***\n\nLogging to "${transports.file}"${
        transports.console ? " and console.log" : ""
      } via the debug module\nwith  DEBUG='${
        process.env.DEBUG
      }'.\nUse   DEBUG_FILE='path' and DEBUG_CONSOLE=[yes|no] to override.\nUsing e.g., something like DEBUG='cocalc:*,-cocalc:silly:*' to control log levels.\n\n***`;
      console.log(announce);
      if (transports.file) {
        // the file transport
        fileStream.write(announce);
      }
      firstLog = false;
    }
    // Similar as in debug source code, except I stuck a timestamp
    // at the beginning, which I like... except also aware of
    // non-printf formatting.
    const line = `${new Date().toISOString()} (${process.pid}):${myFormat(...args)}\n`;

    if (transports.console) {
      // the console transport:
      console.log(line);
    }
    if (transports.file) {
      // the file transport
      fileStream.write(line);
    }
  };
}

initTransports();

const DEBUGGERS = {
  error: COCALC.extend("error"),
  warn: COCALC.extend("warn"),
  info: COCALC.extend("info"),
  http: COCALC.extend("http"),
  verbose: COCALC.extend("verbose"),
  debug: COCALC.extend("debug"),
  silly: COCALC.extend("silly"),
};

type Level = keyof typeof DEBUGGERS;

const LEVELS: Level[] = [
  "error",
  "warn",
  "info",
  "http",
  "verbose",
  "debug",
  "silly",
];

class Logger {
  private name: string;
  private debuggers: { [level: string]: Debugger } = {};

  constructor(name: string) {
    this.name = name;
    for (const level of LEVELS) {
      this.debuggers[level] = DEBUGGERS[level].extend(name);
      this[level] = (...args) => {
        this.counter(level);
        // @ts-ignore
        this.debuggers[level](...args);
      };
    }
  }

  public isEnabled(level: Level): boolean {
    return this.debuggers[level].enabled;
  }

  public extend(name: string) {
    return new Logger(`${this.name}:${name}`);
  }

  private counter(level: Level): void {
    if (counter == null) return;
    counter.labels(this.name, level).inc(1);
  }
}

export interface WinstonLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  http: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  silly: (...args: unknown[]) => void;
  verbose: Function;
  extend: (name: string) => WinstonLogger;
  isEnabled: (level: Level) => boolean;
}

const cache: { [name: string]: WinstonLogger } = {};
export default function getLogger(name: string): WinstonLogger {
  if (cache[name] != null) {
    return cache[name];
  }
  // smash it over since we build Logger pretty generically so typescript
  // doesn't get it.  But we care that all *client* code uses the WinstonLogger
  // interface.
  return (cache[name] = new Logger(name) as unknown as WinstonLogger);
}

export { getLogger };

let counter: any = undefined;
export function setCounter(f) {
  counter = f;
}
