/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  ENV_AUTH_PROFILE,
  type GlobalAuthOptions,
} from "../../core/auth-config";

const MAX_COOKIE_BYTES = 16 * 1024;

// `--cookie-file` passes a session cookie without putting it on the command
// line (visible in `ps`). Like --api-key-file, it replaces every other
// credential source, including the selected auth profile.
export function resolveCookieFileGlobals<
  T extends GlobalAuthOptions & { cookieFile?: string },
>(globals: T): T & GlobalAuthOptions {
  if (!globals.cookieFile) return globals;
  if (globals.cookie?.trim() || globals.apiKey?.trim()) {
    throw new Error("use --cookie-file without --cookie or --api-key");
  }
  return {
    ...globals,
    cookieFile: undefined,
    cookie: readCookieFile(globals.cookieFile),
    apiKey: undefined,
    apiKeyFile: undefined,
    bearer: undefined,
    hubPassword: undefined,
    disableEnvAuthDefaults: true,
    profile: ENV_AUTH_PROFILE,
  };
}

export function readCookieFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("cookie file is unavailable");
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_COOKIE_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error(
        "cookie file must be private, nonempty, regular, and under 16 KiB",
      );
    }
    const bytes = Buffer.alloc(MAX_COOKIE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_COOKIE_BYTES) throw new Error("cookie file is too large");
    const cookie = bytes.subarray(0, length).toString("utf8").trim();
    if (!cookie || /[\r\n]/.test(cookie)) {
      throw new Error("cookie file must contain one Cookie header value");
    }
    return cookie;
  } finally {
    closeSync(fd);
  }
}
