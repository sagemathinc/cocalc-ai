import type { ApiProjectSummaryPage } from "@cocalc/conat/hub/api/projects";

export async function listProjectsWithApiKey({
  apiBaseUrl,
  apiKey,
  limit,
  offset,
  search,
}: {
  apiBaseUrl: string;
  apiKey: string;
  limit: number;
  offset: number;
  search?: string;
}): Promise<ApiProjectSummaryPage> {
  const response = await fetch(new URL("/api/conat/hub", apiBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "projects.listProjectSummaries",
      args: [{ limit, offset, search }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw Error(`project list HTTP request failed (${response.status})`);
  }
  const value = await response.json();
  if (value?.error) {
    throw Error(`${value.error}`);
  }
  if (!Array.isArray(value?.projects)) {
    throw Error("invalid project list response");
  }
  return value as ApiProjectSummaryPage;
}
