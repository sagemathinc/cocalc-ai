/** Literal conversation search shared by live messages and saved history. */
export function searchableChatText(content: string): string {
  return content.replace(/<[^>]*>/g, " ");
}

export function chatSearchIndex(content: string, query: string): number {
  const needle = query.trim().toLowerCase();
  return needle
    ? searchableChatText(content).toLowerCase().indexOf(needle)
    : -1;
}
