// account_id is bound by the authenticated ACP subject, never by prompt text.
export function assertSameTurnPrincipal(
  executionAccountId: string | null | undefined,
  requestingAccountId: string | undefined,
): void {
  if (!executionAccountId || executionAccountId !== requestingAccountId) {
    throw Object.assign(
      new Error(
        "This turn executes under another account. Queue a new turn under your account instead of steering it.",
      ),
      { code: "principal_mismatch" },
    );
  }
}
