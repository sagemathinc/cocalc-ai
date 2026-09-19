import {
  projectFundingUsage,
  getCourseFundingUsageProjection,
} from "./usage-projection";

const now = new Date("2026-09-12T10:00:00Z");
const base = {
  as_of: now,
  remaining_usd: "6",
  ends_at: new Date("2026-09-13T00:00:00Z"),
  window_headroom_usd: "100",
  window_ends_at: new Date("2026-09-12T15:00:00Z"),
};
const observation = {
  state: "consuming",
  resource_kind: "compute-vm",
  updated_at: now.toISOString(),
  running_until: now.toISOString(),
  hourly_cost_usd: "2",
  storage_hourly_cost_usd: "0.1",
  remaining_usd: "1.21",
  protected_usd: "0.21",
  egress_usd: "1",
};
it("forecasts from exact trusted running and stopped storage rates", () => {
  expect(
    projectFundingUsage({ ...base, observations: [observation] }),
  ).toMatchObject({
    active_reservations: 1,
    running_vms: 1,
    hourly_usd: "2.0000000000",
    forecast_exhausts_at: "2026-09-12T13:00:00.000Z",
  });
  expect(
    projectFundingUsage({
      ...base,
      observations: [
        { ...observation, state: "settling", stopped_until: now.toISOString() },
      ],
    }),
  ).toMatchObject({ running_vms: 0, hourly_usd: "0.1000000000" });
});
it("excludes protected storage and egress from runtime backing", () => {
  const result = projectFundingUsage({
    ...base,
    remaining_usd: "0.75",
    observations: [
      { ...observation, remaining_usd: "1.25", hourly_cost_usd: "0.0748" },
    ],
    window_ends_at: new Date("2026-09-13T00:00:00Z"),
  });
  const hours =
    (Date.parse(result.forecast_exhausts_at!) - now.valueOf()) / 3600000;
  expect(hours).toBeCloseTo(0.79 / 0.0748, 5);
});
it("caps forecast by current payer windows and pool/grant end dates", () => {
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      window_headroom_usd: "1",
    }).forecast_exhausts_at,
  ).toBe("2026-09-12T10:30:00.000Z");
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      ends_at: new Date("2026-09-12T11:00:00Z"),
    }).forecast_exhausts_at,
  ).toBe("2026-09-12T11:00:00.000Z");
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      window_ends_at: new Date("2026-09-12T12:00:00Z"),
    }).forecast_exhausts_at,
  ).toBe("2026-09-12T12:00:00.000Z");
});
it("does not project beyond a reduced window or an unavailable policy", () => {
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      window_headroom_usd: "-3",
    }).forecast_exhausts_at,
  ).toBe(now.toISOString());
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      window_headroom_usd: undefined,
    }),
  ).toMatchObject({ running_vms: 1, hourly_usd: "2.0000000000" });
  expect(
    projectFundingUsage({
      ...base,
      observations: [observation],
      window_headroom_usd: undefined,
    }).forecast_exhausts_at,
  ).toBeUndefined();
});
it("reports zero ongoing rate for trusted deletion even with stale settling meters", () => {
  expect(
    projectFundingUsage({
      ...base,
      observations: [
        {
          ...observation,
          terminal: true,
          state: "settling",
          stopped_until: "2026-09-11T10:00:00Z",
        },
      ],
    }),
  ).toEqual({
    usage_as_of: now.toISOString(),
    active_reservations: 1,
    running_vms: 0,
    hourly_usd: "0.0000000000",
  });
});
it.each(["reserved", "dispatched", "uncertain"])(
  "does not invent runtime counts or rates for %s",
  (state) => {
    const result = projectFundingUsage({
      ...base,
      observations: [{ ...observation, state }],
    });
    expect(result).toEqual({
      usage_as_of: now.toISOString(),
      active_reservations: 1,
    });
  },
);
it("omits forecasts and counts for stale or missing meters", () => {
  for (const running_until of [undefined, "2026-09-12T09:50:00Z"]) {
    const result = projectFundingUsage({
      ...base,
      observations: [{ ...observation, running_until }],
    });
    expect(result.running_vms).toBeUndefined();
    expect(result.hourly_usd).toBeUndefined();
  }
});
it("reports known empty reservation observations as zero without a forecast", () => {
  expect(projectFundingUsage({ ...base, observations: [] })).toEqual({
    usage_as_of: now.toISOString(),
    active_reservations: 0,
    running_vms: 0,
    hourly_usd: "0.0000000000",
  });
});
it("scopes the SQL projection to only the requesting beneficiary", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  await getCourseFundingUsageProjection({ query } as any, {
    grant_ids: ["grant"],
    beneficiary_account_id: "student",
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("g.beneficiary_account_id=$3"),
    [["grant"], null, "student"],
  );
});
