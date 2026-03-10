export function buildAgentCommitPrompt({
  message,
  includeSummary,
}: {
  message: string;
  includeSummary: boolean;
}): string {
  const trimmed = message.trim();
  if (includeSummary) {
    return trimmed
      ? [
          "Please commit all tracked changes in the current repository using `git commit -a`.",
          "Do not add or include untracked files.",
          `Use this exact first line for the commit message: "${trimmed}"`,
        ].join("\n")
      : [
          "Please commit all tracked changes in the current repository using `git commit -a`.",
          "Do not add or include untracked files.",
          "Write the commit message yourself.",
        ].join("\n");
  }
  return trimmed
    ? [
        "Please commit all tracked changes in the current repository using `git commit -a`.",
        "Do not add or include untracked files.",
        "Use this exact commit message:",
        trimmed,
      ].join("\n")
    : [
        "Please commit all tracked changes in the current repository using `git commit -a`.",
        "Do not add or include untracked files.",
      ].join("\n");
}
