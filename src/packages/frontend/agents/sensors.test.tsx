import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSensor } from "@cocalc/conat/agents/sensors";
import { AgentSensorsModal } from "./sensors";
import { sensorsSummary } from "./sensors-store";

const mockApi = {
  listSensors: jest.fn(),
  manageSensor: jest.fn(),
};
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
}));

const agent = {
  name: "watcher",
  endpoint: {
    project_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
  },
} as any;

const spec = {
  title: "GitHub: new issues",
  purpose: "Wake me when an issue is opened.",
  language: "python" as const,
  script: "print('checking')",
  schedule: { kind: "interval" as const, minutes: 30, timezone: "UTC" },
  timeout_seconds: 60,
  max_wakes_per_day: 24,
};

function sensor(overrides: Partial<AgentSensor> = {}): AgentSensor {
  return {
    sensor_id: "33333333-3333-4333-8333-333333333333",
    project_id: agent.endpoint.project_id,
    agent_id: agent.endpoint.agent_id,
    status: "pending",
    spec: null,
    script_hash: null,
    pending_spec: spec,
    pending_hash: "h",
    proposed_at: "2026-10-10T12:00:00.000Z",
    revision: 3,
    approved_by: null,
    approved_at: null,
    pause_reason: null,
    next_run_at: null,
    last_run_at: null,
    last_outcome: null,
    last_wake_at: null,
    consecutive_failures: 0,
    wakes_today: 0,
    created: "2026-10-10T12:00:00.000Z",
    updated: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockApi.listSensors.mockReset();
  mockApi.manageSensor.mockReset().mockResolvedValue({});
});

test("a proposal shows the full script and approves the revision reviewed", async () => {
  const refresh = jest.fn();
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[sensor()]}
      error=""
      refresh={refresh}
    />,
  );
  const card = screen.getByRole("region", {
    name: "Sensor GitHub: new issues",
  });
  expect(
    within(card).getByText(
      /proposed this sensor. Nothing runs until you approve it/,
    ),
  ).toBeTruthy();
  expect(within(card).getByText("Every 30 minutes")).toBeTruthy();
  expect(within(card).getByLabelText("Python 3 script").textContent).toBe(
    "print('checking')",
  );
  await userEvent.click(
    within(card).getByRole("button", { name: "Approve and run" }),
  );
  expect(mockApi.manageSensor).toHaveBeenCalledWith({
    project_id: agent.endpoint.project_id,
    sensor_id: "33333333-3333-4333-8333-333333333333",
    op: "approve",
    revision: 3,
  });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

test("an active sensor offers run, pause and its log, and shows errors", async () => {
  mockApi.manageSensor.mockRejectedValueOnce(
    new Error("this sensor ran less than a minute ago"),
  );
  mockApi.listSensors.mockResolvedValue({
    sensors: [],
    runs: [
      {
        run_id: "r",
        sensor_id: "s",
        started_at: "2026-10-10T12:00:00.000Z",
        finished_at: "2026-10-10T12:00:01.000Z",
        outcome: "wake",
        exit_code: 0,
        summary: "1 new issue",
        output: "stdout:\nok",
        error: null,
        manual: false,
      },
    ],
  });
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[
        sensor({
          status: "active",
          spec,
          pending_spec: null,
          script_hash: "h",
          wakes_today: 2,
          last_run_at: "2026-10-10T12:00:00.000Z",
          last_outcome: "quiet",
        }),
      ]}
      error=""
      refresh={() => {}}
    />,
  );
  expect(screen.getByText(/Woke the agent 2 of 24 times today/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve and run" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  expect(
    await screen.findByText("this sensor ran less than a minute ago"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Run log" }));
  expect(await screen.findByText(/Woke the agent · 1 new issue/)).toBeTruthy();
});

test("sensorsSummary names what needs attention", () => {
  expect(sensorsSummary(undefined)).toBe("");
  expect(sensorsSummary([])).toBe("None");
  expect(
    sensorsSummary([
      sensor(),
      sensor({ status: "active", spec, pending_spec: null }),
      sensor({ status: "paused", spec, pending_spec: null }),
    ]),
  ).toBe("1 active, 1 to review, 1 paused");
});
