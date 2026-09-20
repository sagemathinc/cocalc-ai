/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { useState } from "react";

import {
  ConnectedProjectsSelect,
  defaultCourseConnectedProjectIds,
  vmConnectedProjects,
  type VmConnectedProject,
} from "./compute-vm-connected-projects";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: ({ date }: { date: Date }) => <span>{date.toISOString()}</span>,
}));

const accountId = "account-1";

it("orders eligible projects by account activity and identifies course projects", () => {
  const projects = vmConnectedProjects(
    fromJS({
      older: {
        project_id: "older",
        title: "Older course",
        users: { [accountId]: { group: "collaborator" } },
        course: { project_id: "course-1" },
        last_active: { [accountId]: "2026-09-18T12:00:00.000Z" },
      },
      newest: {
        project_id: "newest",
        title: "Newest course",
        users: { [accountId]: { group: "owner" } },
        course: { project_id: "course-2" },
        last_active: { [accountId]: "2026-09-20T12:00:00.000Z" },
      },
      personal: {
        project_id: "personal",
        title: "Personal project",
        users: { [accountId]: { group: "collaborator" } },
        last_active: { [accountId]: "2026-09-19T12:00:00.000Z" },
      },
      viewer: {
        project_id: "viewer",
        title: "View only",
        users: { [accountId]: { group: "viewer" } },
        course: { project_id: "course-3" },
      },
    }) as any,
    accountId,
  );

  expect(projects.map(({ project_id }) => project_id)).toEqual([
    "newest",
    "personal",
    "older",
  ]);
  expect(defaultCourseConnectedProjectIds(projects)).toEqual([
    "newest",
    "older",
  ]);
});

it("toggles projects and provides a clear unselect-all action", async () => {
  const user = userEvent.setup();
  const projects: VmConnectedProject[] = [
    { project_id: "one", title: "First", course: true },
    { project_id: "two", title: "Second", course: false },
  ];

  function Harness() {
    const [value, setValue] = useState(["one", "two"]);
    return (
      <ConnectedProjectsSelect
        projects={projects}
        value={value}
        onChange={setValue}
      />
    );
  }

  render(<Harness />);
  await user.click(
    screen.getByRole("button", { name: /2 connected projects/i }),
  );
  expect(screen.getByRole("checkbox", { name: /first/i })).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: /second/i }));
  expect(
    screen.getByRole("button", { name: /1 connected project/i }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: /unselect all/i }));
  expect(
    screen.getByRole("button", { name: /0 connected projects/i }),
  ).toBeVisible();
});
