/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function shouldShowWrongAccountListingError(error: unknown): boolean {
  return `${(error as any)?.code ?? ""}`.trim() === "403";
}
