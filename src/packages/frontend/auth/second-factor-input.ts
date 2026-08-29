/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type SecondFactorInputMethod = "totp" | "recovery_code";

export function inferSecondFactorInputMethod(
  code: string,
): SecondFactorInputMethod {
  const trimmed = `${code ?? ""}`.trim();
  if (!trimmed) {
    return "totp";
  }
  const compact = trimmed.replace(/\s+/g, "");
  return /^\d{6}$/.test(compact) ? "totp" : "recovery_code";
}

export function getSecondFactorPlaceholder(
  code: string,
  method?: SecondFactorInputMethod,
): string {
  return (method ?? inferSecondFactorInputMethod(code)) === "recovery_code"
    ? "ABCD-EFGH-IJKL"
    : "123456";
}
