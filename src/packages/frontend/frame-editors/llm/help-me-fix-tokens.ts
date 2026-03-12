export async function getHelpMeFixTokenCounts({
  model,
  solutionText,
  hintText,
}: {
  model: string;
  solutionText: string;
  hintText: string;
}): Promise<{ solutionTokens: number; hintTokens: number }> {
  // This import must stay lazy because the LLM helpers are heavy.
  const { getMaxTokens, numTokensUpperBound } =
    await import("@cocalc/frontend/misc/llm");

  return {
    solutionTokens: numTokensUpperBound(solutionText, getMaxTokens(model)),
    hintTokens: numTokensUpperBound(hintText, getMaxTokens(model)),
  };
}
