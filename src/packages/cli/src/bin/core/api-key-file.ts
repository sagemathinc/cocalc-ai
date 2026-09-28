/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  ENV_AUTH_PROFILE,
  type GlobalAuthOptions,
} from "../../core/auth-config";

// Resolve once per command admission, including before a daemon cache lookup.
// The returned snapshot must not be reread when constructing its connection.
export function resolveApiKeyFileGlobals<T extends GlobalAuthOptions>(
  globals: T,
): T & GlobalAuthOptions {
  if (!globals.apiKeyFile) return globals;
  if (globals.apiKey?.trim()) {
    throw new Error("use either --api-key or --api-key-file, not both");
  }
  const apiKey = readApiKeyFile(globals.apiKeyFile);
  return {
    ...globals,
    apiKeyFile: undefined,
    apiKey,
    cookie: undefined,
    bearer: undefined,
    hubPassword: undefined,
    disableEnvAuthDefaults: true,
    profile: ENV_AUTH_PROFILE,
  };
}

export function readApiKeyFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("API key file is unavailable");
  }
  let apiKey: string;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error(
        "API key file must be private, nonempty, regular, and under 4 KiB",
      );
    }
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 4096) throw new Error("API key file exceeds 4 KiB");
    apiKey = bytes.subarray(0, length).toString("utf8").trim();
    if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) {
      throw new Error("API key file contains an invalid key");
    }
  } finally {
    closeSync(fd);
  }
  return apiKey;
}
