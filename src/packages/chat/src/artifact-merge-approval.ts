/**
 * A merge approval card: references to merge approval requests recorded by
 * the hub (`cocalc project chat merge-approval request`). Only the ids are
 * kept here. Everything the card shows, and every decision, comes from the
 * hub, so nothing written to the chat can approve a merge or change what an
 * approver sees.
 */
export interface ArtifactMergeApproval {
  request_ids: string[];
}

export const MAX_ARTIFACT_MERGE_APPROVAL_REQUESTS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateArtifactMergeApproval(
  value: unknown,
): ArtifactMergeApproval {
  const row =
    (value as any)?.toJS instanceof Function
      ? (value as any).toJS()
      : (value as ArtifactMergeApproval);
  const ids = row?.request_ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_ARTIFACT_MERGE_APPROVAL_REQUESTS ||
    ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw Error(
      `merge_approval.request_ids must be 1 to ${MAX_ARTIFACT_MERGE_APPROVAL_REQUESTS} distinct request ids`,
    );
  return { request_ids: [...ids] };
}
