import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSensor } from "@cocalc/conat/agents/sensors";
import { AgentSensorsModal } from "./sensors";
import { sensorsSummary } from "./sensors-store";

const mockApi = {
  listSensors: jest.fn(),
  manageSensor: jest.fn(),
  createScheduledPrompt: jest.fn(),
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
  kind: "script" as const,
  uses: ["github" as const],
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

test("a proposal shows its facts and script and approves the revision reviewed", async () => {
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
    within(card).getByText(/proposed this. Nothing runs until you approve it/),
  ).toBeTruthy();
  // The access it gets is the agent's, narrowed to what it uses.
  expect(
    within(card).getByText(
      "As you, with this project's files and software, and GitHub",
    ),
  ).toBeTruthy();
  expect(
    within(card).getByText("Every 30 minutes, up to 60 s each"),
  ).toBeTruthy();
  expect(
    within(card).getByText(
      "At most 24 times a day, each a turn on your account",
    ),
  ).toBeTruthy();
  // The script is folded away (an agent reviews it); shown highlighted.
  expect(within(card).queryByLabelText("Python 3 script")).toBeNull();
  await userEvent.click(
    within(card).getByRole("button", { name: "Show Python 3, 1 line" }),
  );
  expect(
    within(card).getByLabelText("Python 3 script").textContent?.trim(),
  ).toBe("print('checking')");
  // Its only buttons: approve, reject or delete the proposal.
  expect(within(card).getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(within(card).getAllByRole("button", { name: "Delete" })).toHaveLength(
    1,
  );
  expect(within(card).queryByRole("button", { name: "Show log" })).toBeNull();
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
        connectors: ["github"],
      },
      {
        run_id: "r0",
        sensor_id: "s",
        started_at: "2026-10-10T11:30:00.000Z",
        finished_at: "2026-10-10T11:30:01.000Z",
        outcome: "wake-coalesced",
        exit_code: 0,
        summary: "2 new issues",
        output: null,
        error: null,
        manual: false,
        connectors: [],
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
  await userEvent.click(screen.getByRole("button", { name: "Show log" }));
  expect(await screen.findByText(/Woke the agent · 1 new issue/)).toBeTruthy();
  expect(screen.getByText("Used GitHub")).toBeTruthy();
  expect(
    screen.getByText(/Held while an earlier wake waited.*2 new issues/),
  ).toBeTruthy();
});

test("Run now opens the log and follows the run to its result", async () => {
  const earlier = {
    run_id: "r0",
    sensor_id: "s",
    started_at: "2026-10-10T12:00:00.000Z",
    finished_at: "2026-10-10T12:00:01.000Z",
    outcome: "quiet",
    exit_code: 0,
    summary: null,
    output: null,
    error: null,
    manual: false,
    connectors: [],
  };
  const running = {
    ...earlier,
    run_id: "r1",
    started_at: "2026-10-10T13:00:00.000Z",
    finished_at: null,
    outcome: null,
    manual: true,
  };
  const done = { ...running, outcome: "wake", summary: "1 new issue" };
  // A scheduled run was already going when Run now was pressed: it is not
  // the run asked for, even when it finishes first.
  const scheduled = {
    ...earlier,
    run_id: "rs",
    started_at: "2026-10-10T12:59:00.000Z",
    finished_at: null,
    outcome: null,
  };
  const scheduledDone = { ...scheduled, outcome: "timeout" };
  mockApi.manageSensor.mockResolvedValue({
    sensor: { updated: "2026-10-10T12:59:30.000Z" },
  });
  // Scheduled run going; it finishes; the requested run runs; it is done.
  mockApi.listSensors
    .mockResolvedValueOnce({ sensors: [], runs: [scheduled, earlier] })
    .mockResolvedValueOnce({ sensors: [], runs: [scheduledDone, earlier] })
    .mockResolvedValueOnce({
      sensors: [],
      runs: [running, scheduledDone, earlier],
    })
    .mockResolvedValue({ sensors: [], runs: [done, scheduledDone, earlier] });
  const refresh = jest.fn();
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
          last_run_at: "2026-10-10T12:00:01.000Z",
          last_outcome: "quiet",
        }),
      ]}
      error=""
      refresh={refresh}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  // No "No runs yet": the run it asked for is on its way.
  expect(await screen.findByText(/Starting the run/)).toBeTruthy();
  expect(screen.queryByText(/No runs yet/)).toBeNull();
  // The scheduled run finishing does not end the wait.
  expect(
    await screen.findByText(/Timed out/, undefined, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(screen.getByText(/Starting the run/)).toBeTruthy();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText(
      /Woke the agent · run by hand · 1 new issue/,
      undefined,
      {
        timeout: 8_000,
      },
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Starting the run/)).toBeNull();
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
}, 25_000);

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
  expect(
    sensorsSummary([
      sensor({
        status: "active",
        pending_spec: null,
        spec: { kind: "watch" } as any,
        next_run_at: "2026-10-10T12:02:00.000Z",
      }),
    ]),
  ).toBe("1 watching");
});

test("a person schedules a prompt for the agent", async () => {
  mockApi.createScheduledPrompt.mockResolvedValue({});
  const refresh = jest.fn();
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[]}
      error=""
      refresh={refresh}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Schedule a prompt" }),
  );
  const form = screen.getByRole("region", { name: "Schedule a prompt" });
  const schedule = within(form).getByRole("button", { name: "Schedule" });
  expect((schedule as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(within(form).getByLabelText("Title"), "Briefing");
  await userEvent.type(
    within(form).getByLabelText("Prompt"),
    "Summarize today.",
  );
  const times = within(form).getByLabelText(/Times/);
  await userEvent.clear(times);
  await userEvent.type(times, "07:00, 17:30");
  await userEvent.click(within(form).getByLabelText("Weekdays only"));
  await userEvent.click(schedule);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  const call = mockApi.createScheduledPrompt.mock.calls[0][0];
  expect(call).toMatchObject({
    project_id: agent.endpoint.project_id,
    agent_id: agent.endpoint.agent_id,
    spec: {
      kind: "prompt",
      title: "Briefing",
      prompt: "Summarize today.",
      schedule: {
        kind: "daily",
        times: ["07:00", "17:30"],
        days: [1, 2, 3, 4, 5],
      },
    },
  });
});

test("a person schedules a quarterly prompt", async () => {
  mockApi.createScheduledPrompt.mockResolvedValue({});
  const refresh = jest.fn();
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[]}
      error=""
      refresh={refresh}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Schedule a prompt" }),
  );
  const form = screen.getByRole("region", { name: "Schedule a prompt" });
  await userEvent.type(within(form).getByLabelText("Title"), "L&I report");
  await userEvent.type(
    within(form).getByLabelText("Prompt"),
    "File the quarterly report.",
  );
  await userEvent.click(within(form).getByRole("radio", { name: "Monthly" }));
  // Weekdays do not apply to days of the month.
  expect(within(form).queryByLabelText("Weekdays only")).toBeNull();
  const dates = within(form).getByLabelText(/Days of the month/);
  await userEvent.clear(dates);
  await userEvent.type(dates, "31");
  await userEvent.click(within(form).getByLabelText(/Quarterly/));
  const times = within(form).getByLabelText(/Times/);
  await userEvent.clear(times);
  await userEvent.type(times, "08:30");
  await userEvent.click(within(form).getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(
    mockApi.createScheduledPrompt.mock.lastCall?.[0].spec.schedule,
  ).toEqual({
    kind: "monthly",
    dates: [31],
    months: [1, 4, 7, 10],
    times: ["08:30"],
    timezone: expect.any(String),
  });
});

test("a watcher shows what it waits for, and is done once it fired", () => {
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[
        sensor({
          // The server reports a fired watcher as done.
          status: "done",
          pending_spec: null,
          spec: {
            kind: "watch",
            title: "CI on a/b#7",
            watch: { type: "ci", repo: "a/b", pr: 7 },
            schedule: { kind: "interval", minutes: 2, timezone: "UTC" },
            max_wakes_per_day: 1,
            expires_at: "2026-10-11T12:00:00.000Z",
          },
          next_run_at: null,
        }),
      ]}
      error=""
      refresh={() => {}}
    />,
  );
  // Finished sensors stay out of the way until asked for.
  expect(
    screen.queryByRole("region", { name: "Sensor CI on a/b#7" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Nothing is watching or scheduled for @watcher right now.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Show 1 finished/ }));
  const card = screen.getByRole("region", { name: "Sensor CI on a/b#7" });
  expect(within(card).getByText("CI checks on a/b#7 finish")).toBeTruthy();
  expect(within(card).getByText("done")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Run now" })).toBeNull();
});

test("current sensors come first; finished ones are behind a toggle", async () => {
  const watch = (
    title: string,
    status: AgentSensor["status"],
    pending = false,
  ) =>
    sensor({
      sensor_id: title,
      status,
      pending_spec: pending ? spec : null,
      spec: {
        kind: "watch",
        title,
        watch: { type: "ci", repo: "a/b", pr: 7 },
        schedule: { kind: "interval", minutes: 2, timezone: "UTC" },
        max_wakes_per_day: 1,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
  render(
    <AgentSensorsModal
      agent={agent}
      open
      onClose={() => {}}
      sensors={[
        watch("Watching CI", "active"),
        // A fired watcher the agent proposed to replace: awaits review.
        watch("Fired, with a proposed revision", "done", true),
        // Watchers cannot be resumed, so a paused one is finished even
        // before it would have given up.
        watch("Paused", "paused"),
        watch("Fired", "done"),
      ]}
      error=""
      refresh={() => {}}
    />,
  );
  const shown = () =>
    screen
      .queryAllByRole("region", { name: /^Sensor / })
      .map((region) => region.getAttribute("aria-label"));
  expect(shown()).toEqual([
    "Sensor Watching CI",
    expect.stringMatching(/^Sensor /),
  ]);
  expect(shown()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /Show 2 finished/ }));
  expect(shown()).toHaveLength(4);
  expect(shown().slice(2)).toEqual(["Sensor Paused", "Sensor Fired"]);

  // By keyboard: the toggle is a real button that keeps focus while the
  // cards it shows or hides come and go below it.
  const toggle = screen.getByRole("button", { name: "Hide finished" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(shown()).toHaveLength(2);
  const show = screen.getByRole("button", { name: /Show 2 finished/ });
  expect(show).toHaveAttribute("aria-expanded", "false");
  expect(show).toHaveFocus();
  await userEvent.keyboard(" ");
  expect(shown()).toHaveLength(4);
  expect(screen.getByRole("button", { name: "Hide finished" })).toHaveFocus();
});
