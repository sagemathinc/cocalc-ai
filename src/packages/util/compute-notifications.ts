export const LOW_CREDIT_NOTIFICATIONS = "low_credit_notifications";
export const LOW_CREDIT_THRESHOLD_USD = "low_credit_threshold_usd";
export const DEFAULT_LOW_CREDIT_THRESHOLD_USD = 10;

export function lowCreditThreshold(
  settings: Record<string, unknown> | null | undefined,
): number | undefined {
  if (settings?.[LOW_CREDIT_NOTIFICATIONS] !== true) return;
  const value =
    settings[LOW_CREDIT_THRESHOLD_USD] ?? DEFAULT_LOW_CREDIT_THRESHOLD_USD;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 1000
  )
    return;
  return value;
}
