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
  alertHostName,
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
  // As in project_hosts: the name is a column, metadata has none.
  return {
    id,
    name: `host-${id}`,
    metadata: {
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
      name: "`host-a`",
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
      { id: "a", name: "`host-a`", kind: "spot_alternate" },
      { id: "b", name: "`host-b`", kind: "standard_fallback" },
      { id: "c", name: "`host-c`", kind: "standard_fallback" },
    ]);
    expect(body).toBe(
      [
        "3 Spot hosts have been on a fallback for more than 24 hours. CoCalc should have moved them back by now; check the host's recovery events.",
        "",
        "On Spot, but another machine type: 1",
        "- `host-a`",
        "",
        "On Standard pricing: 2",
        "- `host-b`",
        "- `host-c`",
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
    expect(body.indexOf("- `host-b`")).toBeLessThan(body.indexOf("- `host-z`"));
    // The name comes from the name column, which the query must select.
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT id, name, metadata/);
  });

  it("never shows the host id: an unnamed host is (unnamed host)", () => {
    const row = host("1a7b2c3d-0000-4000-8000-00000000000n", {
      active_machine_type: "c2d-highcpu-32",
      machine_type_attempt_started_at: hoursAgo(30),
    });
    for (const name of [null, undefined, "  ", "\n\t", 42]) {
      expect(spotFallbackAlertRow({ ...row, name } as any, NOW)?.name).toBe(
        "(unnamed host)",
      );
    }
    const body = formatSpotFallbackAlertBody([
      spotFallbackAlertRow({ ...row, name: null }, NOW)!,
    ]);
    expect(body).toContain("- (unnamed host)");
    expect(body).not.toContain(row.id);
  });

  it("uses the name column first, then metadata.name or display_name", () => {
    const row = host("m", {
      active_machine_type: "c2d-highcpu-32",
      machine_type_attempt_started_at: hoursAgo(30),
    });
    const withMeta = (name: unknown, meta: Record<string, any>) =>
      spotFallbackAlertRow(
        { ...row, name, metadata: { ...row.metadata, ...meta } } as any,
        NOW,
      )?.name;
    expect(withMeta("column", { name: "meta" })).toBe("`column`");
    expect(withMeta(null, { name: "meta" })).toBe("`meta`");
    expect(withMeta("", { display_name: "shown" })).toBe("`shown`");
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

describe("alertHostName", () => {
  it("renders the name as inline code, so it cannot add links or formatting", () => {
    expect(alertHostName("[click](https://evil.example) **x** `y` #h")).toBe(
      "`[click](https://evil.example) **x** y #h`",
    );
    expect(alertHostName("<img src=x>")).toBe("`<img src=x>`");
    // Bare URLs and www. names would be autolinked outside a code span.
    expect(alertHostName("https://phish.example/login")).toBe(
      "`https://phish.example/login`",
    );
    expect(alertHostName("www.evil.example")).toBe("`www.evil.example`");
    // No backtick can close the span early; only backticks is unnamed.
    expect(alertHostName("a``b`` <x>")).toBe("`ab <x>`");
    expect(alertHostName("```")).toBe("(unnamed host)");
    for (const name of ["x`y", "``https://e.example``", "`"]) {
      expect(alertHostName(name).slice(1, -1)).not.toContain("`");
    }
  });

  it("is one line without control or bidi characters", () => {
    expect(alertHostName("a\nb\r\nc\td\u0000e\u2028f")).toBe("`a b c d e f`");
    expect(alertHostName("ab\u202ecd\u2066ef\u200b")).toBe("`abcdef`");
    expect(alertHostName("  my   host  ")).toBe("`my host`");
  });

  it("keeps at most 64 characters", () => {
    expect(alertHostName("x".repeat(64))).toBe(`\`${"x".repeat(64)}\``);
    const long = alertHostName("y".repeat(200)).slice(1, -1);
    expect(Array.from(long)).toHaveLength(64);
    expect(long.endsWith("…")).toBe(true);
    // Whole characters only, never half of an emoji.
    const emoji = alertHostName("😀".repeat(100)).slice(1, -1);
    expect(Array.from(emoji)).toHaveLength(64);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
