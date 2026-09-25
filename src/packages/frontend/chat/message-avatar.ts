export function showParticipantAvatar({
  showAvatar,
  senderId,
  viewerAccountId,
  isAgent,
}: {
  showAvatar?: boolean;
  senderId?: string;
  viewerAccountId?: string;
  isAgent: boolean;
}): boolean {
  return !!showAvatar && !!senderId && senderId !== viewerAccountId && !isAgent;
}
