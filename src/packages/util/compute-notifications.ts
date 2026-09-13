export const LOW_CREDIT_NOTIFICATIONS = "low_credit_notifications";
export const LOW_CREDIT_THRESHOLD_USD = "low_credit_threshold_usd";
export const LOW_COURSE_CREDIT_NOTIFICATIONS =
  "low_course_credit_notifications";
export const LOW_COURSE_CREDIT_THRESHOLD_USD =
  "low_course_credit_threshold_usd";
export const DEFAULT_LOW_CREDIT_THRESHOLD_USD = 10;

export function lowCreditThreshold(
  settings: Record<string, unknown> | null | undefined,
  source: "personal" | "course" = "personal",
): number | undefined {
  const enabled =
    source === "course"
      ? LOW_COURSE_CREDIT_NOTIFICATIONS
      : LOW_CREDIT_NOTIFICATIONS;
  const key =
    source === "course"
      ? LOW_COURSE_CREDIT_THRESHOLD_USD
      : LOW_CREDIT_THRESHOLD_USD;
  if (settings?.[enabled] !== true) return;
  const value = settings[key] ?? DEFAULT_LOW_CREDIT_THRESHOLD_USD;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 1000
  )
    return;
  return value;
}
