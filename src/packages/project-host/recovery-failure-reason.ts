/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Only classify failures with recognizable evidence. Unknown errors retain
// their existing report path so an operator can still diagnose new failures.
export function recoveryFailureReason(
  error: unknown,
  kind: "snapshot" | "backup",
): string | undefined {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /\b(?:EDQUOT|disk quota exceeded|storage quota exceeded)\b/i.test(message)
  ) {
    return "storage_quota_exceeded";
  }
  if (kind !== "backup") return;

  if (
    message.includes("Managed backup upload limit reached for this account.")
  ) {
    return "managed_backup_egress_policy_blocked";
  }
  if (/backup (?:was|is) not confirmed in the repository/i.test(message)) {
    return "repository_confirmation_failed";
  }

  const remoteContext =
    /rustic|repository|\bs3\b|bucket|object[ -]stor(?:e|age)/i.test(message);
  const specificCredentialError =
    /InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|NoCredentialProviders|AuthorizationHeaderMalformed/i.test(
      message,
    );
  if (
    specificCredentialError ||
    (remoteContext &&
      /AccessDenied|(?:invalid|missing) credentials|authentication failed|\b403\b/i.test(
        message,
      ))
  ) {
    return "repository_credentials_invalid";
  }
  if (
    /NoSuchBucket/i.test(message) ||
    (remoteContext &&
      /ServiceUnavailable|SlowDown|RequestTimeout|\b503\b|service unavailable|connection (?:timed out|refused)/i.test(
        message,
      ))
  ) {
    return "object_store_unavailable";
  }
}
