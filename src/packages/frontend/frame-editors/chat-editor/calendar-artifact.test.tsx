/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import CalendarArtifact from "./calendar-artifact";
import { isCalendarPath } from "./file-artifact";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = { fs: () => ({ stat, readFile }), open_file };
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions }),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div data-testid="markdown">{value}</div>,
}));

const calendar = {
  format: "cocalc-calendar",
  version: 1,
  title: "Accounting deadlines",
  timezone: "America/Los_Angeles",
  default_view: "agenda",
  categories: { tax: { label: "Tax filing", color: "#d9480f" } },
  events: [
    {
      id: "withdrawal",
      title: "Confirm EU OSS withdrawal",
      start: "2026-12-01",
      all_day: true,
      due: "2026-12-16",
      category: "tax",
      status: "pending",
      owner: "@accounting",
      details: "Must reach Revenue **15 days** before the quarter ends.",
      links: [
        { label: "ROS", url: "https://ros.ie" },
        { label: "Bad", url: "javascript:alert(1)" },
      ],
    },
    {
      id: "close",
      title: "Month-end close",
      start: "2026-11-03T08:30",
      recurrence: { freq: "monthly", bymonthday: [3] },
    },
    {
      id: "vanta",
      title: "Book the Vanta renewal",
      start: "2026-12-21",
      all_day: true,
      status: "done",
    },
  ],
};

// Dec 19, 4 pm in Seattle.
const NOW = Date.parse("2026-12-20T00:00:00Z");

beforeEach(() => {
  stat.mockResolvedValue({ size: 1000 });
  readFile.mockResolvedValue(JSON.stringify(calendar));
});

test("only .cal.json files are calendars", () => {
  expect(isCalendarPath("/home/user/taxes.cal.json")).toBe(true);
  expect(isCalendarPath("/home/user/TAXES.CAL.JSON")).toBe(true);
  expect(isCalendarPath("/home/user/taxes.json")).toBe(false);
});

test("an agenda: overdue first, then the coming days, details on click", async () => {
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Accounting deadlines" }),
  ).toBeInTheDocument();
  const overdue = screen.getByRole("region", { name: "Overdue" });
  expect(
    within(overdue).getByRole("button", { name: "Confirm EU OSS withdrawal" }),
  ).toBeInTheDocument();
  expect(overdue).toHaveTextContent("Tax filing");
  expect(overdue).toHaveTextContent(/due Dec 16/);
  // The coming days, by date: the done renewal still shows, the close too.
  const regions = screen
    .getAllByRole("region")
    .map((r) => r.getAttribute("aria-label"));
  expect(regions[0]).toBe("Overdue");
  expect(regions.slice(1).join("|")).toMatch(/Dec 21.*\|.*Jan 3/);
  expect(screen.getByText("Book the Vanta renewal")).toHaveStyle({
    textDecoration: "line-through",
  });
  // Details open on click; a link that is not http(s) is never shown.
  const title = within(overdue).getByRole("button", {
    name: "Confirm EU OSS withdrawal",
  });
  expect(title).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(title);
  expect(title).toHaveAttribute("aria-expanded", "true");
  expect(overdue).toHaveTextContent("Owner: @accounting");
  expect(within(overdue).getByTestId("markdown")).toHaveTextContent("15 days");
  expect(within(overdue).getByRole("link", { name: "ROS" })).toHaveAttribute(
    "href",
    "https://ros.ie",
  );
  expect(within(overdue).queryByRole("link", { name: "Bad" })).toBeNull();
});

test("a due time is shown with its time; a due date without", async () => {
  readFile.mockResolvedValue(
    JSON.stringify({
      ...calendar,
      events: [
        {
          id: "timed",
          title: "Timed deadline",
          start: "2026-12-28",
          all_day: true,
          due: "2027-01-31T15:00",
        },
        {
          id: "dated",
          title: "Dated deadline",
          start: "2026-12-29",
          all_day: true,
          due: "2027-01-31",
        },
      ],
    }),
  );
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
    />,
  );
  const row = async (title: string) =>
    (await screen.findByText(title)).parentElement!;
  expect(await row("Timed deadline")).toHaveTextContent(/due Jan 31.*3:00/);
  expect(await row("Dated deadline")).toHaveTextContent(/due Jan 31$/);
});

test("while open, an item becomes overdue when its time comes", async () => {
  jest.useFakeTimers({ now: Date.parse("2027-01-31T22:58:30Z") });
  try {
    readFile.mockResolvedValue(
      JSON.stringify({
        ...calendar,
        events: [
          {
            id: "soon",
            title: "Due at 3 pm",
            start: "2027-01-31",
            all_day: true,
            due: "2027-01-31T15:00",
            status: "pending",
          },
        ],
      }),
    );
    render(
      <CalendarArtifact path="/home/user/a.cal.json" historical={false} />,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Due at 3 pm")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Overdue" })).toBeNull();
    // 3 pm in Seattle passes; the card moves on by itself.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(
      within(screen.getByRole("region", { name: "Overdue" })).getByText(
        "Due at 3 pm",
      ),
    ).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

test("a refresh that fails shows no stale calendar and offers no .ics", async () => {
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
    />,
  );
  await screen.findByRole("heading", { name: "Accounting deadlines" });
  expect(screen.getByRole("button", { name: "Download .ics" })).toBeEnabled();
  readFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText(/ENOENT/)).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Accounting deadlines" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Download .ics" })).toBeDisabled();
});

test("problems are named, and what can be read is still shown", async () => {
  readFile.mockResolvedValue(
    JSON.stringify({
      ...calendar,
      events: [...calendar.events, { id: "broken", title: "No start" }],
    }),
  );
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
    />,
  );
  expect(
    await screen.findByText(
      "Some of this calendar could not be read; the rest is shown.",
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Month-end close").length).toBeGreaterThan(0);
});

test("not a calendar: says so, with the file still openable", async () => {
  readFile.mockResolvedValue("{}");
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
    />,
  );
  expect(
    await screen.findByText("This is not a calendar CoCalc can show."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download .ics" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open in project" }));
  expect(open_file).toHaveBeenCalledWith({ path: "/home/user/a.cal.json" });
});

test("a full-size page gets the tools for its own header", async () => {
  const onToolbarActions = jest.fn();
  render(
    <CalendarArtifact
      path="/home/user/a.cal.json"
      historical={false}
      now={NOW}
      onToolbarActions={onToolbarActions}
    />,
  );
  await screen.findByRole("heading", { name: "Accounting deadlines" });
  const tools = onToolbarActions.mock.lastCall[0];
  expect(tools.map((t) => t.key)).toEqual(["open", "ics", "refresh"]);
  expect(tools.find((t) => t.key === "ics").disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});
