/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";

const ME = "00000000-0000-4000-8000-000000000001";
const DREW = "00000000-0000-4000-8000-000000000002";
const CATHY = "00000000-0000-4000-8000-000000000003";

const projectMap = fromJS({
  shared: {
    title: "Shared",
    last_edited: "2026-10-01",
    users: { [ME]: { group: "owner" }, [DREW]: { group: "collaborator" } },
  },
  newer: {
    title: "Mine only",
    last_edited: "2026-10-03",
    users: { [ME]: { group: "owner" } },
  },
  old_shared: {
    title: "Old shared",
    last_edited: "2026-01-01",
    users: { [ME]: { group: "owner" }, [DREW]: { group: "collaborator" } },
  },
});

const resolveIdentity = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => "William" }) },
  useTypedRedux: (store: string) =>
    store === "projects" ? projectMap : undefined,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { hub: { notifications: {} } } },
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/people/collaborators", () => ({
  usePeople: () => [
    { account_id: DREW, name: "Drew Sutherland" },
    { account_id: CATHY, name: "Cathy" },
  ],
}));
jest.mock("./api", () => ({
  personalAgentApi: () => ({ resolveIdentity }),
  refreshNamedAgents: jest.fn(),
  useNamedAgents: () => ({ directory: { enabled: true, agents: [] } }),
}));
jest.mock("./use-bound-account", () => ({
  useBoundAgentAccount: () => ({
    accountId: ME,
    current: true,
    assertCurrent: () => {},
  }),
}));

import {
  mostRecentSharedProject,
  projectIncludesAll,
} from "./agent-participants";
import { NewAgentPeople } from "./new-agent-people";
import { NameAgent } from "./name-agent";

test("finds the most recent project everyone shares", () => {
  expect(mostRecentSharedProject(projectMap, [DREW])).toBe("shared");
  expect(mostRecentSharedProject(projectMap, [DREW, CATHY])).toBeUndefined();
  expect(projectIncludesAll(projectMap.get("newer"), [DREW])).toBe(false);
});

test("warns when a chosen person can't use the agent's project", async () => {
  const onSelectProject = jest.fn();
  render(
    <NewAgentPeople
      participants={[DREW]}
      onChange={jest.fn()}
      projectId="newer"
      onSelectProject={onSelectProject}
    />,
  );
  expect(screen.getByText(/isn't a collaborator on this project/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Use “Shared”/ }));
  expect(onSelectProject).toHaveBeenCalledWith("shared");
});

test("explains sharing when everyone is on the project", () => {
  render(
    <NewAgentPeople
      participants={[DREW]}
      onChange={jest.fn()}
      projectId="shared"
      onSelectProject={jest.fn()}
    />,
  );
  expect(screen.getByText(/invited when the agent is created/)).toBeTruthy();
  expect(screen.getByText("Drew Sutherland")).toBeTruthy();
});

test("someone else's agent offers Add to my agents with its name", async () => {
  resolveIdentity.mockResolvedValue({
    agent_id: "a1",
    name: "claude-1",
    created_by: DREW,
    disabled_at: null,
  });
  render(<NameAgent projectId="shared" path="a.chat" threadId="t1" />);
  const button = await screen.findByRole("button", {
    name: "Add to my agents",
  });
  await userEvent.click(button);
  await waitFor(() =>
    expect(screen.getByDisplayValue("claude-1")).toBeTruthy(),
  );
});

test("an unregistered thread still offers Name agent", async () => {
  resolveIdentity.mockResolvedValue(undefined);
  render(<NameAgent projectId="shared" path="a.chat" threadId="t2" />);
  await waitFor(() => expect(resolveIdentity).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Name agent" })).toBeTruthy();
});
