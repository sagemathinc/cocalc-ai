import type { ApiKeyActionRequest } from "@cocalc/util/api-key-management";
import {
  normalizeApiKeyActionRequest,
  normalizeApiKeyActionReview,
} from "@cocalc/util/api-key-management";

export async function requestApiKeyActionWithKey({
  apiBaseUrl,
  apiKey,
  request,
}: {
  apiBaseUrl: string;
  apiKey: string;
  request: ApiKeyActionRequest;
}) {
  const canonical = normalizeApiKeyActionRequest(request);
  const response = await fetch(
    new URL("/api/conat/api-key-action", apiBaseUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(canonical),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`API key action request failed (${response.status})`);
  const value = await response.json();
  if (value?.error) throw new Error(`${value.error}`);
  const review = normalizeApiKeyActionReview(value);
  if (
    review.request_id !== canonical.request_id ||
    review.action.target_key_id !== canonical.action.target_key_id
  )
    throw new Error("API key action response does not match request");
  return review;
}
