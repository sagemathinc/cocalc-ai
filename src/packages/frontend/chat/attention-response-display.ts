import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";

export function showAttentionInFooter({
  record,
  hasDraftResponse,
  projected,
  ownerActive,
  ownerExpanded,
}: {
  record: AcpAttentionRecord;
  hasDraftResponse: boolean;
  projected: boolean;
  ownerActive?: boolean;
  ownerExpanded?: boolean;
}): boolean {
  const hasResponse =
    projected || record.response_submitted_at != null || hasDraftResponse;
  if (!hasResponse) return true;
  // The durable row is the answer's full history, not a second footer card.
  // Stale sync answers still need their explicit continuation control.
  const needsRecovery =
    record.state === "stale" && record.source_kind === "codex_sync_question";
  if (projected && !needsRecovery) return false;
  if (ownerActive == null) return true;
  return ownerActive || ownerExpanded === true;
}
