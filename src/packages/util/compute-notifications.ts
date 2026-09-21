export const LOW_CREDIT_NOTIFICATIONS = "low_credit_notifications";
export const LOW_CREDIT_THRESHOLD_USD = "low_credit_threshold_usd";
export const LOW_COURSE_CREDIT_NOTIFICATIONS =
  "low_course_credit_notifications";
export const LOW_COURSE_CREDIT_THRESHOLD_USD =
  "low_course_credit_threshold_usd";
export const LOW_SPONSORED_COMPUTE_NOTIFICATIONS =
  "low_sponsored_compute_notifications";
export const LOW_SPONSORED_COMPUTE_THRESHOLD_USD =
  "low_sponsored_compute_threshold_usd";
export const DEFAULT_LOW_CREDIT_THRESHOLD_USD = 10;

// Private bay-service transport, not a public account mutation.
export interface ComputeResourceNotice {
  id: string;
  account_id: string;
  resource_id: string;
  resource_kind: "vm" | "volume";
  resource_name: string;
  action: "stop" | "delete";
  phase: "requested" | "completed";
  observed_at: string;
}

export function lowCreditThreshold(
  settings: Record<string, unknown> | null | undefined,
  source: "personal" | "course" | "sponsored" = "personal",
): number | undefined {
  const enabled =
    source === "sponsored"
      ? LOW_SPONSORED_COMPUTE_NOTIFICATIONS
      : source === "course"
        ? LOW_COURSE_CREDIT_NOTIFICATIONS
        : LOW_CREDIT_NOTIFICATIONS;
  const key =
    source === "sponsored"
      ? LOW_SPONSORED_COMPUTE_THRESHOLD_USD
      : source === "course"
        ? LOW_COURSE_CREDIT_THRESHOLD_USD
        : LOW_CREDIT_THRESHOLD_USD;
  if (settings?.[enabled] !== true) return;
  const value = settings[key] ?? DEFAULT_LOW_CREDIT_THRESHOLD_USD;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > (source === "sponsored" ? 1_000_000 : 1000)
  )
    return;
  return value;
}
