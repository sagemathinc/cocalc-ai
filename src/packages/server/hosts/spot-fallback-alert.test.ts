const mockQuery = jest.fn();
const mockConditionAlert = jest.fn();
const mockConditionCleared = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));

jest.mock("./condition-alert", () => ({
  ...jest.requireActual("./condition-alert"),
  conditionAlert: (...args: any[]) => mockConditionAlert(...args),
  conditionCleared: (...args: any[]) => mockConditionCleared(...args),
}));

import {
  formatSpotFallbackAlertBody,
  runSpotFallbackAlertCheck,
  SPOT_FALLBACK_ALERT_SUBJECT,
  spotFallbackAlertRow,
} from "./spot-fallback-alert";

const NOW = Date.parse("2026-11-13T06:00:00.000Z");
const hoursAgo = (hours: number) =>
  new Date(NOW - hours * 60 * 60 * 1000).toISOString();

function host(
  id: string,
  state: Record<string, any>,
  extra: Record<string, any> = {},
) {
  return {
    id,
    metadata: {
      name: `host-${id}`,
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      machine: { machine_type: "t2d-standard-16" },
      spot_recovery_state: { phase: "idle", ...state },
      ...extra,
    },
  };
}

describe("spotFallbackAlertRow", () => {
  it("flags a Spot alternate machine type after more than 24 h", () => {
    const alternate = (hours: number) =>
      host("a", {
        active_machine_type: "n2d-custom-32-65536",
        machine_type_attempt_started_at: hoursAgo(hours),
      });
    expect(spotFallbackAlertRow(alternate(25), NOW)).toEqual({
      id: "a",
      name: "host-a",
      kind: "spot_alternate",
    });
    expect(spotFallbackAlertRow(alternate(23), NOW)).toBeUndefined();
    expect(spotFallbackAlertRow(alternate(24), NOW)).toBeUndefined();
  });

  it("flags Standard fallback by its own start time", () => {
    const standard = (hours: number) =>
      host(
        "s",
        {
          phase: "running_standard_fallback",
          fallback_started_at: hoursAgo(hours),
          // An older alternate attempt must not count for Standard.
          machine_type_attempt_started_at: hoursAgo(100),
        },
        { effective_pricing_model: "on_demand" },
      );
    expect(spotFallbackAlertRow(standard(30), NOW)?.kind).toBe(
      "standard_fallback",
    );
    expect(spotFallbackAlertRow(standard(2), NOW)).toBeUndefined();
  });

  it("ignores hosts on their desired Spot type, non-Spot hosts and unknown times", () => {
    expect(
      spotFallbackAlertRow(
        host("d", {
          active_machine_type: "t2d-standard-16",
          machine_type_attempt_started_at: hoursAgo(100),
        }),
        NOW,
      ),
    ).toBeUndefined();
    expect(
      spotFallbackAlertRow(
        host(
          "o",
          {
            active_machine_type: "n2-standard-32",
            machine_type_attempt_started_at: hoursAgo(100),
          },
          { desired_pricing_model: "on_demand" },
        ),
        NOW,
      ),
    ).toBeUndefined();
    expect(
      spotFallbackAlertRow(
        host("u", { active_machine_type: "n2d-custom-32-65536" }),
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("formatSpotFallbackAlertBody", () => {
  it("lists counts and host names only, in a stable form", () => {
    const body = formatSpotFallbackAlertBody([
      { id: "a", name: "host-a", kind: "spot_alternate" },
      { id: "b", name: "host-b", kind: "standard_fallback" },
      { id: "c", name: "host-c", kind: "standard_fallback" },
    ]);
    expect(body).toBe(
      [
        "3 Spot hosts have been on a fallback for more than 24 hours. CoCalc should have moved them back by now; check the host's recovery events.",
        "",
        "On Spot, but another machine type: 1",
        "- host-a",
        "",
        "On Standard pricing: 2",
        "- host-b",
        "- host-c",
      ].join("\n"),
    );
    expect(body).not.toMatch(/host_id|t2d|n2d|\d{4}-\d{2}-\d{2}/);
  });
});

describe("runSpotFallbackAlertCheck", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConditionAlert.mockReset();
    mockConditionCleared.mockReset();
  });

  it("alerts admins once per condition, sorted by host id", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        host("z", {
          active_machine_type: "n2d-custom-32-65536",
          machine_type_attempt_started_at: hoursAgo(48),
        }),
        host("b", {
          active_machine_type: "c2d-highcpu-32",
          machine_type_attempt_started_at: hoursAgo(30),
        }),
        host("y", {}),
      ],
    });
    await expect(runSpotFallbackAlertCheck(NOW)).resolves.toBe(2);
    expect(mockConditionCleared).not.toHaveBeenCalled();
    expect(mockConditionAlert).toHaveBeenCalledTimes(1);
    const [{ subject, body, reminderMinutes }] =
      mockConditionAlert.mock.calls[0];
    expect(subject).toBe(SPOT_FALLBACK_ALERT_SUBJECT);
    expect(reminderMinutes).toBe(24 * 60);
    expect(body.indexOf("- host-b")).toBeLessThan(body.indexOf("- host-z"));
  });

  it("clears the condition when no host is over 24 h", async () => {
    mockQuery.mockResolvedValue({ rows: [host("y", {})] });
    await expect(runSpotFallbackAlertCheck(NOW)).resolves.toBe(0);
    expect(mockConditionAlert).not.toHaveBeenCalled();
    expect(mockConditionCleared).toHaveBeenCalledWith(
      SPOT_FALLBACK_ALERT_SUBJECT,
    );
  });
});
