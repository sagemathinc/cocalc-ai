/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";

/** Stable exact-path identity for personal warning preferences only. Never use
 * this as a backup exclusion, file-version identity, or deletion authorization.
 * Input is the report's raw root-relative path, preserving non-UTF8 names.
 */
export function backupPathAcknowledgementKey(pathHex: string): string {
  if (
    typeof pathHex !== "string" ||
    pathHex.length > 8192 ||
    !/^(?:[0-9a-f]{2})+$/.test(pathHex)
  )
    throw new Error("Invalid backup acknowledgement path");
  const path = Buffer.from(pathHex, "hex");
  const segments = path.toString("latin1").split("/");
  if (
    path.includes(0) ||
    segments.some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Invalid backup acknowledgement path");
  return createHash("sha256")
    .update("cocalc-backup-warning-path-v1\0")
    .update(path)
    .digest("hex");
}
