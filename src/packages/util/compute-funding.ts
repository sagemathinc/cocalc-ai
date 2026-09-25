/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "./misc";
import { moneyToDbString, toDecimal } from "./money";

export type ComputeFundingLane = "prepaid" | "postpaid";

export type ComputeFundingSource =
  | { kind: "course"; pool_id: string; grant_id: string }
  | { kind: "personal"; lane: ComputeFundingLane };

export type ComputeFundingPoolState =
  | "scheduled"
  | "active"
  | "suspended"
  | "closing"
  | "closed";
export type ComputeFundingGrantState =
  | "scheduled"
  | "active"
  | "exhausted"
  | "expired"
  | "revoked";
export type ComputeFundingReservationState =
  | "reserved"
  | "dispatched"
  | "consuming"
  | "uncertain"
  | "settling"
  | "settled";

export const COURSE_COMPUTE_DEFAULT_STOP_HOURS = 6;
export const COURSE_COMPUTE_RETENTION_HOURS = 72;
export const COURSE_COMPUTE_MAX_RECIPIENTS = 1000;

export type ComputeFundingErrorCode =
  | "invalid_funding_request"
  | "funding_overcommitted"
  | "insufficient_funding"
  | "funding_conflict"
  | "funding_not_found"
  | "funding_unavailable";

export class ComputeFundingError extends Error {
  constructor(
    public readonly code: ComputeFundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputeFundingError";
  }
}

/** Decimal strings only: never silently round or accept a JSON float as money. */
export function fundingAmount(
  value: unknown,
  {
    positive = false,
    cents = false,
  }: { positive?: boolean; cents?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,9})(\.\d{1,10})?$/.test(value)
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Funding amounts must be nonnegative decimal strings with at most 10 fractional digits.",
    );
  }
  const amount = toDecimal(value);
  if ((positive && amount.lte(0)) || (cents && amount.decimalPlaces() > 2)) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      cents
        ? "Budget amounts must be positive whole-cent amounts."
        : "Funding amount must be positive.",
    );
  }
  return moneyToDbString(amount);
}

export function fundingId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      `${label} must be a UUID.`,
    );
  }
  return value.toLowerCase();
}

export function fundingDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Funding dates require an ISO timestamp with a timezone.",
    );
  }
  const local = new Date(value.replace(/(Z|[+-]\d{2}:\d{2})$/, "Z"));
  if (
    !Number.isFinite(local.getTime()) ||
    local.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Funding dates must be valid calendar dates.",
    );
  }
  return new Date(value).toISOString();
}

export interface CourseFundingRecipient {
  beneficiary_account_id: string;
  amount_usd: string;
}

export interface CourseFundingDraft {
  course_project_id: string;
  course_instance_id: string;
  currency: "USD";
  lane: ComputeFundingLane;
  amount_usd: string;
  starts_at: string;
  ends_at: string;
  allow_overcommit: boolean;
  recipients: CourseFundingRecipient[];
}

/** Normalizes proposal terms only. This is not financial authorization. */
export function normalizeCourseFundingDraft(
  value: CourseFundingDraft,
): CourseFundingDraft {
  if (
    !value ||
    value.currency !== "USD" ||
    !["prepaid", "postpaid"].includes(value.lane) ||
    typeof value.allow_overcommit !== "boolean"
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Choose USD funding and an explicit funding lane and overcommit policy.",
    );
  }
  const course_project_id = fundingId(
    value.course_project_id,
    "Course project",
  );
  const course_instance_id = fundingId(
    value.course_instance_id,
    "Course instance",
  );
  const amount_usd = fundingAmount(value.amount_usd, {
    positive: true,
    cents: true,
  });
  const starts_at = fundingDate(value.starts_at);
  const ends_at = fundingDate(value.ends_at);
  if (starts_at >= ends_at) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Funding must end after it starts.",
    );
  }
  if (
    !Array.isArray(value.recipients) ||
    value.recipients.length > COURSE_COMPUTE_MAX_RECIPIENTS
  ) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      `A funding batch supports up to ${COURSE_COMPUTE_MAX_RECIPIENTS} students.`,
    );
  }
  const seen = new Set<string>();
  const recipients = value.recipients
    .map((recipient) => {
      const beneficiary_account_id = fundingId(
        recipient?.beneficiary_account_id,
        "Student account",
      );
      if (seen.has(beneficiary_account_id)) {
        throw new ComputeFundingError(
          "invalid_funding_request",
          "Each student account may appear only once in an allocation batch.",
        );
      }
      seen.add(beneficiary_account_id);
      return {
        beneficiary_account_id,
        amount_usd: fundingAmount(recipient?.amount_usd, {
          positive: true,
          cents: true,
        }),
      };
    })
    .sort((a, b) =>
      a.beneficiary_account_id.localeCompare(b.beneficiary_account_id),
    );
  const total = recipients.reduce(
    (sum, recipient) => sum.add(recipient.amount_usd),
    toDecimal(0),
  );
  if (!value.allow_overcommit && total.gt(amount_usd)) {
    throw new ComputeFundingError(
      "funding_overcommitted",
      "Student allowances exceed the backed pool. Reduce allowances or explicitly confirm overcommit.",
    );
  }
  return {
    course_project_id,
    course_instance_id,
    currency: "USD",
    lane: value.lane,
    amount_usd,
    starts_at,
    ends_at,
    allow_overcommit: value.allow_overcommit,
    recipients,
  };
}

export interface FundingBudget {
  authorized_usd: string;
  spent_usd: string;
  reserved_usd: string;
  released_usd: string;
}

export function fundingBudgetSummary(budget: FundingBudget): {
  backing_usd: string;
  available_usd: string;
} {
  const authorized = toDecimal(fundingAmount(budget.authorized_usd));
  const spent = toDecimal(fundingAmount(budget.spent_usd));
  const reserved = toDecimal(fundingAmount(budget.reserved_usd));
  const released = toDecimal(fundingAmount(budget.released_usd));
  const backing = authorized.minus(spent).minus(released);
  const available = backing.minus(reserved);
  if (available.lt(0)) {
    throw new ComputeFundingError(
      "insufficient_funding",
      "Spent and reserved funds exceed the authorized budget.",
    );
  }
  return {
    backing_usd: moneyToDbString(backing),
    available_usd: moneyToDbString(available),
  };
}

/** Protected cleanup funds are included in, not added to, the reservation. */
export function validateFundingReservation(
  amount: string,
  protectedAmount: string,
): { amount_usd: string; protected_usd: string } {
  const amount_usd = fundingAmount(amount, { positive: true });
  const protected_usd = fundingAmount(protectedAmount);
  if (toDecimal(protected_usd).gt(amount_usd)) {
    throw new ComputeFundingError(
      "invalid_funding_request",
      "Protected cleanup funds cannot exceed the reservation.",
    );
  }
  return { amount_usd, protected_usd };
}
