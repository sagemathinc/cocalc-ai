import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReplaceRoomDialog } from "./replace-room-dialog";
import type { DirectoryApi } from "./workspace-api";
import { replaceConversationRoom } from "./replace-room";

jest.mock("./replace-room", () => ({ replaceConversationRoom: jest.fn() }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
const accountId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const room = {
  project_id: projectId,
  room_id: "33333333-3333-4333-8333-333333333333",
  chat_path: "/home/user/.cocalc/collaborators.chat",
  initialized: true,
};
const getRoom = jest.fn();
const api = { getRoom } as unknown as DirectoryApi;
const mockReplace = replaceConversationRoom as jest.Mock;
const onStart = jest.fn();
const computedStyle = window.getComputedStyle;
beforeAll(() =>
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => computedStyle(element)),
);
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  sessionStorage.clear();
  getRoom.mockReset().mockResolvedValue(room);
  mockReplace.mockReset().mockResolvedValue({
    outcome: "ready",
    room: { ...room, room_id: accountId },
  });
  onStart.mockReset();
});
function Example() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Manage deleted room</button>
      {open && (
        <ReplaceRoomDialog
          api={api}
          accountId={accountId}
          projectId={projectId}
          projectTitle="Research seminar"
          onClose={() => setOpen(false)}
          onStart={onStart}
        />
      )}
    </>
  );
}
async function open() {
  render(<Example />);
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: "Manage deleted room" }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("dialog", {
    name: "Replace deleted conversation room",
  });
  const checkbox = screen.getByRole("checkbox", { name: /I understand/ });
  await waitFor(() => expect(checkbox).toHaveFocus());
  return checkbox;
}

test("read-only opening focuses confirmation and hides IDs/paths behind collapsed technical details", async () => {
  await open();
  expect(getRoom).toHaveBeenCalledWith({ project_id: projectId });
  expect(mockReplace).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByText("Research seminar")).toBeVisible(),
  );
  expect(screen.getByText(room.room_id)).not.toBeVisible();
  expect(screen.getByText(room.chat_path)).not.toBeVisible();
  expect(
    screen.getByRole("button", { name: "Replace deleted room" }),
  ).toBeDisabled();
  const summary = screen.getByText("Technical details");
  summary.focus();
  await userEvent.keyboard("{Enter}");
  // jsdom does not implement native details keyboard activation; the control
  // remains a native summary, and pointer activation exercises its disclosure.
  await userEvent.click(summary);
  expect(screen.getByText(room.room_id)).toBeVisible();
});

test("explicit keyboard confirmation replaces once, then focuses the separate start action", async () => {
  await open();
  await userEvent.keyboard(" ");
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: "Replace deleted room" }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const start = await screen.findByRole("button", {
    name: "Start a discussion",
  });
  await waitFor(() => expect(start).toHaveFocus());
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(mockReplace.mock.calls[0][0]).toMatchObject({
    accountId,
    request: {
      version: 1,
      project_id: projectId,
      expected_room_id: room.room_id,
      expected_chat_path: room.chat_path,
    },
  });
  expect(onStart).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledTimes(1);
});

test("Escape restores opener focus and creates nothing", async () => {
  await open();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Manage deleted room" }),
  ).toHaveFocus();
  expect(mockReplace).not.toHaveBeenCalled();
});

test("unknown outcomes reuse persisted intent across closing and reopening", async () => {
  mockReplace.mockRejectedValueOnce(Error("lost acknowledgement"));
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  const retry = await screen.findByRole("button", {
    name: "Retry same replacement",
  });
  await waitFor(() => expect(retry).toHaveFocus());
  const intent = mockReplace.mock.calls[0][0].request;
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  getRoom.mockResolvedValue({ ...room, room_id: accountId });
  await userEvent.click(
    screen.getByRole("button", { name: "Manage deleted room" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: /I understand/ }),
    ).toHaveFocus(),
  );
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Retry same replacement" }),
  );
  await screen.findByRole("button", { name: "Start a discussion" });
  expect(mockReplace.mock.calls[1][0].request).toEqual(intent);
  expect(getRoom).toHaveBeenCalledTimes(1);
});

test("abandoning a failed intent reloads a moved registration and requires new explicit confirmation", async () => {
  mockReplace.mockRejectedValueOnce(Error("room moved; expected path changed"));
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  await screen.findByRole("alert");
  const original = mockReplace.mock.calls[0][0].request;
  const moved = { ...room, chat_path: "/home/user/moved/conversations.chat" };
  getRoom.mockResolvedValue(moved);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Abandon saved attempt and reload registration",
    }),
  );
  const checkbox = screen.getByRole("checkbox", { name: /I understand/ });
  await waitFor(() => expect(checkbox).toHaveFocus());
  expect(checkbox).not.toBeChecked();
  expect(getRoom).toHaveBeenCalledTimes(2);
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(
    sessionStorage.getItem(
      `collaborators:room-replacement:${accountId}:${projectId}`,
    ),
  ).toBeNull();
  const replace = screen.getByRole("button", { name: "Replace deleted room" });
  expect(replace).toBeDisabled();
  await userEvent.click(replace);
  expect(mockReplace).toHaveBeenCalledTimes(1);
  checkbox.focus();
  await userEvent.keyboard(" ");
  expect(checkbox).toBeChecked();
  await userEvent.click(replace);
  await screen.findByRole("button", { name: "Start a discussion" });
  const renewed = mockReplace.mock.calls[1][0].request;
  expect(renewed.request_id).not.toBe(original.request_id);
  expect(renewed).toMatchObject({
    expected_room_id: room.room_id,
    expected_chat_path: moved.chat_path,
  });
});

test("abandonment cannot overlap an in-flight replacement and never initializes a pending registration", async () => {
  let finish!: (value: unknown) => void;
  mockReplace.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  const abandon = await screen.findByRole("button", {
    name: "Abandon saved attempt and reload registration",
  });
  expect(abandon).toBeDisabled();
  await userEvent.click(abandon);
  expect(getRoom).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ outcome: "pending", room: { ...room, initialized: false } });
  });
  expect(abandon).toBeEnabled();
  getRoom.mockResolvedValue({ ...room, initialized: false });
  await userEvent.click(abandon);
  await screen.findByRole("alert");
  expect(
    screen.getByRole("checkbox", { name: /I understand/ }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Retry same replacement" }),
  ).toBeDisabled();
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

test("registration read failures after abandonment can be explicitly reloaded without a mutation", async () => {
  mockReplace.mockRejectedValueOnce(Error("unknown outcome"));
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  await screen.findByRole("alert");
  getRoom.mockRejectedValueOnce(Error("registration unavailable"));
  await userEvent.click(
    screen.getByRole("button", {
      name: "Abandon saved attempt and reload registration",
    }),
  );
  await screen.findByText("registration unavailable", { exact: false });
  await userEvent.click(
    screen.getByRole("button", { name: "Reload current registration" }),
  );
  const checkbox = screen.getByRole("checkbox", { name: /I understand/ });
  await waitFor(() => expect(checkbox).toHaveFocus());
  expect(checkbox).not.toBeChecked();
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

test("Escape during an abandoned intent's reload restores focus and ignores its late response", async () => {
  mockReplace.mockRejectedValueOnce(Error("lost acknowledgement"));
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  await screen.findByRole("alert");
  let finish!: (value: unknown) => void;
  getRoom.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: "Abandon saved attempt and reload registration",
    }),
  );
  screen.getByRole("button", { name: "Cancel" }).focus();
  await userEvent.keyboard("{Escape}");
  await act(async () => {
    finish(room);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Manage deleted room" }),
  ).toHaveFocus();
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

test("late read after Escape cannot refocus or mutate", async () => {
  let finish!: (room: unknown) => void;
  getRoom.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Example />);
  await userEvent.click(
    screen.getByRole("button", { name: "Manage deleted room" }),
  );
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  await userEvent.keyboard("{Escape}");
  await act(async () => {
    finish(room);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Manage deleted room" }),
  ).toHaveFocus();
  expect(mockReplace).not.toHaveBeenCalled();
});

test("superseded replay focuses Close without opening or creating another room", async () => {
  mockReplace.mockResolvedValue({ outcome: "superseded" });
  await open();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace deleted room" }),
  );
  const close = await screen.findByRole("button", {
    name: "Close replacement dialog",
  });
  await waitFor(() => expect(close).toHaveFocus());
  expect(onStart).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Start a discussion" }),
  ).not.toBeInTheDocument();
});
