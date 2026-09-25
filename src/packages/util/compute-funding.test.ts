import {
  fundingAmount,
  fundingBudgetSummary,
  normalizeCourseFundingDraft,
  validateFundingReservation,
} from "./compute-funding";
import type { CourseFundingDraft } from "./compute-funding";

const account = "00000000-0000-4000-8000-000000000001";
const draft = (): CourseFundingDraft => ({
  course_project_id: account,
  course_instance_id: "00000000-0000-4000-8000-000000000002",
  currency: "USD",
  lane: "prepaid",
  amount_usd: "1000",
  starts_at: "2026-09-12T00:00:00Z",
  ends_at: "2026-09-19T00:00:00Z",
  allow_overcommit: false,
  recipients: Array.from({ length: 20 }, (_, index) => ({
    beneficiary_account_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    amount_usd: "50",
  })),
});

describe("course funding money contract", () => {
  it.each([
    0,
    1.1,
    NaN,
    Infinity,
    null,
    undefined,
    "",
    "-1",
    " 1",
    "1 ",
    "1e2",
    "0x10",
    "01",
    "1.00000000001",
    "10000000000",
    "Infinity",
    "NaN",
  ])("rejects invalid monetary input %p", (value) => {
    expect(() => fundingAmount(value)).toThrow();
  });
  it("preserves metering precision and rejects fractional-cent budgets", () => {
    expect(fundingAmount("0.0000000001")).toBe("0.0000000001");
    expect(fundingAmount("9999999999.9999999999")).toBe(
      "9999999999.9999999999",
    );
    expect(fundingAmount("50.000", { cents: true })).toBe("50.0000000000");
    expect(() => fundingAmount("0", { positive: true })).toThrow();
    expect(() => fundingAmount("50.001", { cents: true })).toThrow();
  });
  it("counts nested holds once", () => {
    expect(
      fundingBudgetSummary({
        authorized_usd: "1000",
        spent_usd: "200",
        reserved_usd: "100",
        released_usd: "50",
      }),
    ).toEqual({
      backing_usd: "750.0000000000",
      available_usd: "650.0000000000",
    });
  });
  it("fails closed on inconsistent counters", () => {
    expect(() =>
      fundingBudgetSummary({
        authorized_usd: "50",
        spent_usd: "49",
        reserved_usd: "1.0000000001",
        released_usd: "0",
      }),
    ).toThrow();
  });
  it("protects teardown within the reserved amount", () => {
    expect(validateFundingReservation("5", "2")).toEqual({
      amount_usd: "5.0000000000",
      protected_usd: "2.0000000000",
    });
    expect(() => validateFundingReservation("1", "2")).toThrow();
  });
});

describe("course allocation proposals", () => {
  it("normalizes the Manchester 20 x 50 scenario", () => {
    const result = normalizeCourseFundingDraft(draft());
    expect(result.amount_usd).toBe("1000.0000000000");
    expect(result.recipients).toHaveLength(20);
    expect(result.starts_at).toBe("2026-09-12T00:00:00.000Z");
    expect(result.recipients[0].amount_usd).toBe("50.0000000000");
  });
  it("requires explicit overcommit", () => {
    const input = { ...draft(), amount_usd: "999.99" };
    expect(() => normalizeCourseFundingDraft(input)).toThrow(/exceed/);
    expect(
      normalizeCourseFundingDraft({ ...input, allow_overcommit: true })
        .allow_overcommit,
    ).toBe(true);
  });
  it("rejects duplicate student accounts including case variants", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() =>
      normalizeCourseFundingDraft({
        ...draft(),
        recipients: [
          { beneficiary_account_id: id, amount_usd: "1" },
          { beneficiary_account_id: id.toUpperCase(), amount_usd: "1" },
        ],
      }),
    ).toThrow(/only once/);
  });
  it.each([
    "2026-09-12",
    "2026-09-12T00:00:00",
    "2026-02-30T00:00:00Z",
    "2026-09-12T24:00:00Z",
    "invalid",
  ])("rejects ambiguous dates: %s", (starts_at) => {
    expect(() =>
      normalizeCourseFundingDraft({ ...draft(), starts_at }),
    ).toThrow();
  });
  it("compares timezone-normalized dates", () => {
    expect(() =>
      normalizeCourseFundingDraft({
        ...draft(),
        starts_at: "2026-09-19T01:00:00+01:00",
      }),
    ).toThrow(/end after/);
  });
  it("rejects non-USD, missing overcommit policy and unresolved recipients", () => {
    expect(() =>
      normalizeCourseFundingDraft({ ...draft(), currency: "GBP" } as any),
    ).toThrow();
    expect(() =>
      normalizeCourseFundingDraft({
        ...draft(),
        allow_overcommit: undefined,
      } as any),
    ).toThrow();
    expect(() =>
      normalizeCourseFundingDraft({
        ...draft(),
        recipients: [
          { beneficiary_account_id: "student@example.com", amount_usd: "50" },
        ],
      }),
    ).toThrow();
  });
});
