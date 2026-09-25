import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";

type CodexSubscription = NonNullable<
  CodexPaymentSourceInfo["subscriptions"]
>[number];

/** Keep account identifiers out of routine UI unless the user chose a label. */
export function getCodexSubscriptionDisplayName(
  subscription: CodexSubscription,
  subscriptions: CodexSubscription[],
): string {
  const label = subscription.label?.trim();
  if (label) return label;
  // API ordering follows recency, so rank opaque stable IDs instead. Using the
  // response order would rename subscriptions after one is used or reconnected.
  const index = [...subscriptions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .findIndex(({ id }) => id === subscription.id);
  return index > 0 ? `ChatGPT - ${index + 1}` : "ChatGPT";
}
