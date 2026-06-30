/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function getErrorMessage(error: unknown): string {
  return `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`
    .trim()
    .toLowerCase();
}

export function isConatInfoBootstrapTimeout(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (!message.includes("once: timeout")) {
    return false;
  }
  return (
    message.includes('waiting for "info"') ||
    message.includes("waiting for 'info'") ||
    message.includes("waiting for info")
  );
}
