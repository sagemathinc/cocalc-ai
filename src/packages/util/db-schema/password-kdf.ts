/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * The password_kdf site setting is one-way: once it is "scrypt", it can never
 * be set back. Otherwise new password hashes would be weak again, and failed
 * sign-ins would cost less for missing and legacy accounts than for strong
 * ones (an account existence timing oracle). set_server_setting, which every write
 * path uses (the generic site_settings user-query set is disabled), checks
 * this; the seed propagates "scrypt" to every bay, so the switch
 * holds cluster-wide.
 */
export const PASSWORD_KDF_ONE_WAY_ERROR =
  "password_kdf is one-way: once it is 'scrypt' it cannot be changed back";

export function passwordKdfChangeError(
  current: unknown,
  next: unknown,
): string | undefined {
  if (`${current ?? ""}` === "scrypt" && `${next ?? ""}` !== "scrypt") {
    return PASSWORD_KDF_ONE_WAY_ERROR;
  }
}

/** The refusal above, as an Error or as the message a callback API passes. */
export function isPasswordKdfOneWayError(err: unknown): boolean {
  const message =
    typeof err === "string" ? err : (err as { message?: unknown })?.message;
  return `${message ?? ""}`.startsWith(PASSWORD_KDF_ONE_WAY_ERROR);
}
