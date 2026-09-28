import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import React from "react";
import { InviteProjects } from "./invite-projects";

const mockAdd = jest.fn();
const mockProjects = fromJS({
  first: {
    project_id: "first",
    title: "First project",
    last_edited: 2,
    users: { me: { group: "owner" } },
  },
  second: {
    project_id: "second",
    title: "Second project",
    last_edited: 1,
    users: { me: { group: "collaborator" } },
  },
  viewer: {
    project_id: "viewer",
    title: "Viewer project",
    users: { me: { group: "viewer" } },
  },
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useState: React.useState,
  useMemo: React.useMemo,
  useTypedRedux: () => mockProjects,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { account_id: "me" },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading</div>,
}));
jest.mock("./add-collaborators", () => ({
  AddCollaborators: (props) => {
    mockAdd(props);
    return (
      <button onClick={() => props.onBusyChange(true)}>
        Start mocked invitation
      </button>
    );
  },
}));

beforeEach(() => mockAdd.mockClear());

it("selects multiple projects by keyboard and only mounts invitation entry after confirmation", async () => {
  const user = userEvent.setup();
  render(<InviteProjects onClose={jest.fn()} />);
  const selector = screen.getByRole("combobox", {
    name: "Projects to invite to",
  });
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  await user.tab();
  await user.tab();
  expect(selector).toHaveFocus();
  expect(screen.getByRole("button", { name: "Choose person" })).toBeDisabled();
  expect(mockAdd).not.toHaveBeenCalled();
  await user.type(selector, "First");
  fireEvent.keyDown(selector, { key: "Enter", keyCode: 13, which: 13 });
  fireEvent.keyUp(selector, { key: "Enter", keyCode: 13, which: 13 });
  expect(selector).toHaveValue("");
  await user.type(selector, "Second");
  expect(selector).toHaveValue("Second");
  expect(screen.getByRole("option", { name: "Second project" })).toBeTruthy();
  fireEvent.keyDown(selector, { key: "Enter", keyCode: 13, which: 13 });
  fireEvent.keyUp(selector, { key: "Enter", keyCode: 13, which: 13 });
  fireEvent.keyDown(selector, { key: "Escape", keyCode: 27, which: 27 });
  expect(mockAdd).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Choose person" }));
  expect(mockAdd.mock.lastCall[0].project_ids).toEqual(["first", "second"]);
  expect(selector).toBeDisabled();
});

it("hands selection to existing project creation without mounting invitation entry", async () => {
  const create = jest.fn();
  render(
    <InviteProjects
      initialProjectIds={["first"]}
      onClose={jest.fn()}
      onCreateProject={create}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(create).toHaveBeenCalledWith(["first"]);
  expect(mockAdd).not.toHaveBeenCalled();
});

it("passes a selected person through and prevents dismissal during submission", async () => {
  const close = jest.fn();
  const person = { account_id: "person", display_name: "Person" };
  render(
    <InviteProjects
      initialProjectIds={["first", "second"]}
      person={person}
      onClose={close}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Choose person" }));
  expect(mockAdd.mock.lastCall[0].initialPerson).toEqual(person);
  await userEvent.click(
    screen.getByRole("button", { name: "Start mocked invitation" }),
  );
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Start mocked invitation" }),
    { key: "Escape" },
  );
  expect(close).not.toHaveBeenCalled();
});

it("closes with Escape and restores focus to the opener", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Invite person</button>
        {open && <InviteProjects onClose={() => setOpen(false)} />}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Invite person" });
  await user.click(opener);
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(opener).toHaveFocus());
});
