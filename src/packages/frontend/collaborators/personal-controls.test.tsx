import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonalControls } from "./personal-controls";
import { emptyCollaborationPersonalState } from "@cocalc/util/collaborators";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";

const resource: CollaborationResource = {
  project_id: "project",
  resource_id: "thread",
  kind: "conversation",
  title: "Office hours",
  chat_path: "/room.chat",
  thread_id: "thread",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 4,
};

test("keyboard collection, follow, mute, alias, and read actions send independent patches", async () => {
  const user = userEvent.setup();
  let state = emptyCollaborationPersonalState();
  const setPersonalState = jest.fn(
    async ({ patch }) => (state = { ...state, ...patch }),
  );
  render(
    <PersonalControls
      api={{ setPersonalState } as unknown as DirectoryApi}
      resource={resource}
      onChange={jest.fn()}
    />,
  );
  for (const [name, patch] of [
    ["Add to my collection", { collected: true }],
    ["Follow", { following: true }],
    ["Mute", { muted: true }],
    ["Mark read", { read_through: 4 }],
    ["Remove shortcut", { collected: false }],
  ] as const) {
    const button = screen.getByRole("button", { name, exact: true });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(setPersonalState).toHaveBeenLastCalledWith({
        project_id: "project",
        kind: "conversation",
        resource_id: "thread",
        patch,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Personal preferences saved."),
      ).toBeInTheDocument(),
    );
  }
  expect(state.following).toBe(true);
  expect(state.muted).toBe(true);
  await user.type(
    screen.getByRole("textbox", { name: "Private alias" }),
    "weekly",
  );
  screen.getByRole("button", { name: "Save alias" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(setPersonalState).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: { alias: "weekly" } }),
    ),
  );
});

test("failed mutations announce errors without changing the pressed state", async () => {
  const user = userEvent.setup();
  render(
    <PersonalControls
      api={
        {
          setPersonalState: jest
            .fn()
            .mockRejectedValue(Error("Access removed")),
        } as unknown as DirectoryApi
      }
      resource={resource}
      onChange={jest.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Follow", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access removed");
  expect(
    screen.getByRole("button", { name: "Follow", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("compact conversation controls support keyboard pin, alias, sharing and focus restoration", async () => {
  const user = userEvent.setup();
  let state = emptyCollaborationPersonalState();
  const setPersonalState = jest.fn(
    async ({ patch }) => (state = { ...state, ...patch }),
  );
  const share = jest.fn();
  const outerShortcut = jest.fn();
  render(
    <div onKeyDown={outerShortcut}>
      <PersonalControls
        compact
        resource={resource}
        onChange={jest.fn()}
        onShare={share}
        api={{ setPersonalState } as unknown as DirectoryApi}
      />
    </div>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  screen.getByRole("button", { name: "Pin conversation" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Unpin conversation" });
  expect(state.following).toBe(false);
  const menu = screen.getByRole("button", { name: "Conversation options" });
  menu.focus();
  await user.keyboard("{Enter}");
  const alias = await screen.findByRole("menuitem", {
    name: "Private alias...",
  });
  act(() => alias.focus());
  outerShortcut.mockClear();
  // rc-menu still uses the legacy `which` supplied by real keyboard events.
  expect(
    fireEvent.keyDown(alias, { key: "Enter", which: 13, keyCode: 13 }),
  ).toBe(false);
  expect(outerShortcut).not.toHaveBeenCalled();
  const input = await screen.findByRole("textbox", { name: "Private alias" });
  await user.type(input, "weekly");
  await user.click(screen.getByRole("button", { name: "Save alias" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(menu).toHaveFocus());
  expect(state.alias).toBe("weekly");
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", {
      name: "Add link to another conversation...",
    }),
  );
  expect(share).toHaveBeenCalledTimes(1);
  expect(menu).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Private alias..." });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(menu).toHaveFocus());
});

test("clearing an artifact alias by keyboard preserves its independent shortcut and attention state", async () => {
  const user = userEvent.setup();
  const personal = {
    ...emptyCollaborationPersonalState(),
    alias: "my-result",
    collected: true,
    following: true,
    muted: true,
  };
  const setPersonalState = jest
    .fn()
    .mockResolvedValue({ ...personal, alias: undefined });
  render(
    <PersonalControls
      api={{ setPersonalState } as unknown as DirectoryApi}
      resource={{
        ...resource,
        kind: "artifact",
        entry_id: "entry",
        artifact_id: "artifact",
        personal,
      }}
      onChange={jest.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Private alias" });
  await user.clear(input);
  const save = screen.getByRole("button", { name: "Save alias" });
  expect(save).toBeEnabled();
  save.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(setPersonalState).toHaveBeenCalledWith({
      project_id: "project",
      kind: "artifact",
      resource_id: "thread",
      patch: { alias: "" },
    }),
  );
  await screen.findByText("Personal preferences saved.");
  expect(input).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Remove shortcut" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: /follow/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
});

test("an unnamed agent can be collected and aliased without execution identity enrollment", async () => {
  const user = userEvent.setup();
  let state = emptyCollaborationPersonalState();
  const setPersonalState = jest.fn(
    async ({ patch }) => (state = { ...state, ...patch }),
  );
  const ensureRoom = jest.fn();
  render(
    <PersonalControls
      api={{ setPersonalState, ensureRoom } as unknown as DirectoryApi}
      resource={{ ...resource, kind: "agent" }}
      onChange={jest.fn()}
    />,
  );
  const collect = screen.getByRole("button", { name: "Add to my collection" });
  expect(collect).toBeEnabled();
  collect.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Remove shortcut" });
  await user.type(
    screen.getByRole("textbox", { name: "Private alias" }),
    "shared-research",
  );
  screen.getByRole("button", { name: "Save alias" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(setPersonalState).toHaveBeenCalledTimes(2));
  expect(setPersonalState.mock.calls.map(([opts]) => opts.patch)).toEqual([
    { collected: true },
    { alias: "shared-research" },
  ]);
  expect(state).toMatchObject({
    collected: true,
    alias: "shared-research",
    following: false,
    muted: false,
  });
  expect(ensureRoom).not.toHaveBeenCalled();
});

test.each(["agent", "artifact"] as const)(
  "%s exposes alias and collection, not conversation attention",
  (kind) => {
    render(
      <PersonalControls
        api={{ setPersonalState: jest.fn() } as unknown as DirectoryApi}
        resource={{
          ...resource,
          kind,
          entry_id: "entry",
          artifact_id: "artifact",
        }}
        onChange={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Private alias" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Add to my collection" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /follow/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark read" })).toBeNull();
  },
);
