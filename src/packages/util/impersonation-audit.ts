// Shared validation for operator-supplied audit context, not proof of consent.
export function impersonationReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "An impersonation reason is required; describe the purpose and authorization (for example, a support ticket).",
    );
  }
  const reason = value.trim();
  if (reason.length > 512) {
    throw new Error("Impersonation reason must be at most 512 characters");
  }
  return reason;
}

export function impersonationSupportContext(opts: {
  support_ticket_id?: number;
  consent_reference?: string;
}) {
  const { support_ticket_id, consent_reference } = opts;
  if (
    support_ticket_id != null &&
    (!Number.isSafeInteger(support_ticket_id) || support_ticket_id <= 0)
  ) {
    throw new Error("Support ticket id must be a positive integer");
  }
  let consent: string | undefined;
  if (consent_reference != null) {
    if (
      typeof consent_reference !== "string" ||
      !consent_reference.trim() ||
      consent_reference.trim().length > 512
    ) {
      throw new Error("Consent reference must be between 1 and 512 characters");
    }
    consent = consent_reference.trim();
  }
  if (support_ticket_id != null && !consent) {
    throw new Error(
      "A consent reference is required for support impersonation",
    );
  }
  return { support_ticket_id, consent_reference: consent };
}

export const IMPERSONATION_SESSION_MAX_TTL_SECONDS = 12 * 3600;
export const IMPERSONATION_SESSION_MIN_TTL_SECONDS = 60;

/** Validate an optional shorter lifetime for the impersonation session. */
export function impersonationSessionTtlSeconds(
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < IMPERSONATION_SESSION_MIN_TTL_SECONDS ||
    seconds > IMPERSONATION_SESSION_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `session_ttl_seconds must be an integer from ${IMPERSONATION_SESSION_MIN_TTL_SECONDS} to ${IMPERSONATION_SESSION_MAX_TTL_SECONDS}`,
    );
  }
  return seconds;
}

/** Session lifetime for a consumed grant: the grant's TTL, at most 12 hours. */
export function impersonationSessionMaxAgeMs(
  metadata?: Record<string, unknown> | null,
): number {
  try {
    const seconds = impersonationSessionTtlSeconds(
      metadata?.session_ttl_seconds,
    );
    if (seconds != null) return seconds * 1000;
  } catch {
    // An invalid stored value never extends the session.
    return IMPERSONATION_SESSION_MIN_TTL_SECONDS * 1000;
  }
  return IMPERSONATION_SESSION_MAX_TTL_SECONDS * 1000;
}
