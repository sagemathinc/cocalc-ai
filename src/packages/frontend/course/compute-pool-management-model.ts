import type {
  CourseFundingCourseRequest,
  CourseFundingPoolChangeDraft,
  CourseFundingPoolSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import { fundingAmount } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import { localDateTime } from "./compute-budget-model";

export function usableCeiling(row: {
  authorized_usd: string;
  released_usd: string;
}) {
  return moneyToDbString(toDecimal(row.authorized_usd).minus(row.released_usd));
}

export function poolChangeDraft(
  opts: CourseFundingCourseRequest & {
    pool: CourseFundingPoolSummary;
    action: "revise" | "revoke" | "close";
    amount: string;
    starts: string;
    ends: string;
    amounts: Record<string, string>;
    selected: string[];
  },
): CourseFundingPoolChangeDraft {
  const { pool } = opts;
  if (!pool.version) throw Error("Refresh the pool before making changes.");
  const draft: CourseFundingPoolChangeDraft = {
    course_project_id: opts.course_project_id,
    course_instance_id: opts.course_instance_id,
    pool_id: pool.id,
    expected_version: pool.version,
    action: opts.action === "close" ? "close" : "revise",
  };
  if (opts.action === "close") return draft;
  if (opts.action === "revoke") {
    draft.grants = pool.grants
      .filter((g) => opts.selected.includes(g.id) && g.state !== "revoked")
      .map((g) => {
        if (!g.version)
          throw Error("Refresh student grants before making changes.");
        return {
          grant_id: g.id,
          expected_version: g.version,
          action: "revoke",
        };
      });
    if (!draft.grants.length) throw Error("Select at least one student grant.");
    return draft;
  }
  const amount = fundingAmount(opts.amount, { positive: true, cents: true });
  if (!toDecimal(amount).eq(usableCeiling(pool))) draft.amount_usd = amount;
  const dates: { starts_at?: string; ends_at?: string } = {};
  if (opts.starts !== localDateTime(new Date(pool.starts_at)))
    dates.starts_at = new Date(opts.starts).toISOString();
  if (opts.ends !== localDateTime(new Date(pool.ends_at)))
    dates.ends_at = new Date(opts.ends).toISOString();
  Object.assign(draft, dates);
  draft.grants = pool.grants
    .filter((g) => g.state !== "revoked")
    .flatMap((g) => {
      const amount_usd = toDecimal(opts.amounts[g.id] || "0").eq(
        usableCeiling(g),
      )
        ? undefined
        : fundingAmount(opts.amounts[g.id], { positive: true, cents: true });
      if (amount_usd === undefined && !Object.keys(dates).length) return [];
      if (!g.version)
        throw Error("Refresh student grants before making changes.");
      return [
        {
          grant_id: g.id,
          expected_version: g.version,
          action: "revise" as const,
          ...(amount_usd === undefined ? {} : { amount_usd }),
          ...dates,
        },
      ];
    });
  if (!draft.grants.length) delete draft.grants;
  if (!draft.amount_usd && !Object.keys(dates).length && !draft.grants)
    throw Error("No budget or date changes.");
  return draft;
}
