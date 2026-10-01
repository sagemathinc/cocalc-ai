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
  // A transcript proves the answer was saved, not that the agent received it.
  // Keep failed delivery visible even after the owning turn is collapsed.
  if (
    record.state === "stale" &&
    ["codex_sync_question", "codex_async_question"].includes(record.source_kind)
  )
    return true;
  if (projected) return false;
  if (ownerActive == null) return true;
  return ownerActive || ownerExpanded === true;
}
