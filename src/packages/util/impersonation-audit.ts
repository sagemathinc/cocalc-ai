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
