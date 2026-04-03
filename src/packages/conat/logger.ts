/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  silly: (...args: unknown[]) => void;
}

export type LoggerFactory = (name: string) => Logger;

export const FALLBACK_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
};

let loggerFactory: LoggerFactory | undefined;

export function setConatLoggerFactory(factory?: LoggerFactory): void {
  loggerFactory = factory;
}

function tmpLogger(level: keyof Logger, name: string, logger: Logger) {
  return (...args: unknown[]) => {
    if (loggerFactory == null) {
      return;
    }
    const next = loggerFactory(name);
    for (const key of Object.keys(next) as Array<keyof Logger>) {
      logger[key] = next[key];
    }
    logger[level](...args);
  };
}

export function getLogger(name: string): Logger {
  try {
    if (loggerFactory != null) {
      return loggerFactory(name);
    }
  } catch {}

  const logger = {} as Logger;
  for (const level of ["debug", "info", "warn", "error", "silly"] as const) {
    logger[level] = tmpLogger(level, name, logger);
  }
  logger.silly = (..._args) => {};
  return logger;
}
