/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fromJS } from "immutable";
import { NewConversationModal } from "./new-conversation";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const carol = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const names = { [bob]: "Bob", [carol]: "Carol" };

// Bob is a collaborator in P1 and only a viewer in P2; Carol is in P2.
const mockProjects = {
  [P1]: {
    title: "Project one",
    users: { [me]: { group: "owner" }, [bob]: { group: "collaborator" } },
  },
  [P2]: {
    title: "Project two",
    users: {
      [me]: { group: "owner" },
      [bob]: { group: "viewer" },
      [carol]: { group: "collaborator" },
    },
  },
};
const mockProjectMap = fromJS(mockProjects);
const mockCreate = jest.fn();
// A picker that offers every project (whatever its filter says).
let mockIgnoreFilter = false;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "projects" && key === "project_map"
      ? mockProjectMap
      : store === "account" && key === "account_id"
        ? me
        : undefined,
  redux: { getStore: () => ({ get_name: (id: string) => names[id] }) },
}));
// The project picker, reduced to one button per project its filter allows.
jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: ({ filter, onChange, value }) => (
    <div>
      {Object.entries(mockProjects)
        .filter(([, project]) => mockIgnoreFilter || filter(project))
        .map(([id, project]) => (
          <button
            type="button"
            key={id}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            {project.title}
          </button>
        ))}
    </div>
  ),
}));
jest.mock("./create", () => ({
  createConversation: (opts) => mockCreate(opts),
}));
jest.mock("./api", () => ({
  peopleApi: () => ({ addConversation: jest.fn() }),
  conversationsChanged: jest.fn(),
}));

function modal(props: {
  open: boolean;
  personId?: string;
  personName?: string;
}) {
  return (
    <NewConversationModal {...props} onClose={() => {}} onCreated={() => {}} />
  );
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ conversation_id: "x" });
  mockIgnoreFilter = false;
});

test("with a person, only projects where they are a full collaborator", () => {
  render(modal({ open: true, personId: bob, personName: "Bob" }));
  expect(screen.getByRole("button", { name: "Project one" })).toBeTruthy();
  // Bob is only a viewer there: a conversation can't be with him.
  expect(screen.queryByRole("button", { name: "Project two" })).toBeNull();
});

test("reopening for another person starts over: project and people", async () => {
  const { rerender } = render(
    modal({ open: true, personId: bob, personName: "Bob" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Project one" }));
  expect(screen.getByText("Bob")).toBeTruthy();
  rerender(modal({ open: false, personId: bob, personName: "Bob" }));
  rerender(modal({ open: true, personId: carol, personName: "Carol" }));
  // Project one isn't shared with Carol, and nothing is chosen.
  expect(screen.queryByRole("button", { name: "Project one" })).toBeNull();
  const two = screen.getByRole("button", { name: "Project two" });
  expect(two.getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Plans" },
  });
  // Bob's project is not kept for Carol: nothing to create in yet.
  const create = () =>
    screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(create().disabled).toBe(true);
  fireEvent.click(two);
  expect(create().disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mockCreate).toHaveBeenCalled());
  expect(mockCreate).toHaveBeenCalledWith({
    project_id: P2,
    title: "Plans",
    member_ids: [carol],
  });
});

test("for an existing file, the help doesn't promise notifications", () => {
  render(modal({ open: true }));
  expect(
    screen.getByText(
      "They are notified of new messages and see it in For you.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByLabelText("An existing .chat file"));
  expect(
    screen.getByText(/In an existing file they are notified once they write/),
  ).toBeTruthy();
});

test("started from a person, a project where they're only a viewer can't drop them", async () => {
  mockIgnoreFilter = true;
  render(modal({ open: true, personId: bob, personName: "Bob" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Plans" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Project two" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Bob isn't a full collaborator in this project",
  );
  const create = screen.getByRole("button", {
    name: "Create",
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  // In a project where Bob is a collaborator, it works.
  fireEvent.click(screen.getByRole("button", { name: "Project one" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() =>
    expect(mockCreate).toHaveBeenCalledWith({
      project_id: P1,
      title: "Plans",
      member_ids: [bob],
    }),
  );
});

test("reopening clears the title, file choice and error of a cancelled attempt", async () => {
  mockCreate.mockRejectedValueOnce(new Error("boom"));
  const { rerender } = render(modal({ open: true }));
  fireEvent.click(screen.getByRole("button", { name: "Project one" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Old plans" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.getByText("Error: boom")).toBeTruthy());
  fireEvent.click(screen.getByLabelText("An existing .chat file"));
  fireEvent.change(screen.getByPlaceholderText("e.g., notes/team.chat"), {
    target: { value: "old.chat" },
  });
  rerender(modal({ open: false }));
  rerender(modal({ open: true }));
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
  expect(
    (screen.getByLabelText("A new chat file") as HTMLInputElement).checked,
  ).toBe(true);
  expect(screen.queryByPlaceholderText("e.g., notes/team.chat")).toBeNull();
  expect(screen.queryByText("Error: boom")).toBeNull();
  // A project alone doesn't make the stale attempt submittable.
  fireEvent.click(screen.getByRole("button", { name: "Project one" }));
  expect(
    (screen.getByRole("button", { name: "Create" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
