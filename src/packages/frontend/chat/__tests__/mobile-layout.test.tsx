/** @jest-environment jsdom */

import { useEffect, useRef, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatRoomLayout } from "../chatroom-layout";
import {
  useChatFocusIsolation,
  useChatVisualViewport,
  useNarrowChatViewport,
} from "../use-chat-viewport";

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  redux: { getActions: () => ({}) },
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("../chatroom-sidebar", () => ({
  ChatRoomSidebar: ({ children }) => <aside>{children}</aside>,
}));

let media: EventTarget & { matches: boolean };
beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false });
  window.matchMedia = jest.fn(() => media) as any;
});

it("preserves the mounted conversation and draft across all layout transitions", () => {
  const mount = jest.fn();
  function Conversation() {
    const [draft, setDraft] = useState("");
    useEffect(mount, []);
    return (
      <input
        aria-label="Draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }
  const props = {
    sidebarWidth: 250,
    setSidebarWidth: jest.fn(),
    sidebarVisible: false,
    setSidebarVisible: jest.fn(),
    totalUnread: 0,
    sidebarContent: <div>Threads</div>,
    chatContent: <Conversation />,
    onNewChat: jest.fn(),
    newChatSelected: false,
  };
  const { rerender } = render(<ChatRoomLayout {...props} variant="default" />);
  const input = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.change(input, { target: { value: "Unsent draft" } });
  for (const variant of ["compact", "default"] as const) {
    for (const hideSidebar of [true, false]) {
      rerender(
        <ChatRoomLayout
          {...props}
          variant={variant}
          hideSidebar={hideSidebar}
        />,
      );
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
      expect((input as HTMLInputElement).value).toBe("Unsent draft");
    }
  }
  expect(mount).toHaveBeenCalledTimes(1);
});

it("responds to layout width and keyboard viewport changes", () => {
  const visual = Object.assign(new EventTarget(), {
    height: 780,
    offsetTop: 0,
    offsetLeft: 12,
    width: 390,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: visual,
  });
  function Harness() {
    const narrow = useNarrowChatViewport();
    const viewport = useChatVisualViewport(narrow);
    return <output>{JSON.stringify({ narrow, ...viewport })}</output>;
  }
  const { unmount } = render(<Harness />);
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(screen.getByRole("status").textContent).toContain('"height":780');
  act(() => {
    visual.height = 390;
    visual.offsetTop = 24;
    visual.dispatchEvent(new Event("resize"));
  });
  expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual({
    narrow: true,
    height: 390,
    top: 24,
    left: 12,
    width: 390,
  });
  unmount();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
});

it("makes covered navigation inert and restores its original state on exit", () => {
  function Harness({ focused }) {
    const ref = useRef<HTMLDivElement>(null);
    useChatFocusIsolation(ref, focused);
    return (
      <main style={{ overflow: "hidden" }}>
        <button>Project navigation</button>
        <div ref={ref}>
          <button>Chat action</button>
        </div>
      </main>
    );
  }
  const { rerender } = render(<Harness focused={false} />);
  const nav = screen.getByRole("button", { name: "Project navigation" });
  nav.inert = false;
  rerender(<Harness focused />);
  expect(nav.inert).toBe(true);
  expect(nav.style.visibility).toBe("hidden");
  expect(nav.parentElement?.style.overflow).toBe("visible");
  expect(screen.getByRole("button", { name: "Chat action" }).inert).not.toBe(
    true,
  );
  rerender(<Harness focused={false} />);
  expect(nav.inert).toBe(false);
  expect(nav.style.visibility).toBe("");
  expect(nav.parentElement?.style.overflow).toBe("hidden");
});

it("hands focus isolation between chats without leaving the old chat hidden", () => {
  function Chat({ active, name }) {
    const ref = useRef<HTMLDivElement>(null);
    useChatFocusIsolation(ref, active);
    return (
      <div ref={ref} data-testid={name}>
        {name}
      </div>
    );
  }
  function Harness({ active }) {
    return (
      <main>
        <Chat name="first" active={active === "first"} />
        <Chat name="second" active={active === "second"} />
      </main>
    );
  }
  const { rerender } = render(<Harness active="second" />);
  expect(screen.getByTestId("first").style.visibility).toBe("hidden");
  rerender(<Harness active="first" />);
  expect(screen.getByTestId("first").style.visibility).toBe("");
  expect(screen.getByTestId("second").style.visibility).toBe("hidden");
  rerender(<Harness active={null} />);
  expect(screen.getByTestId("first").style.visibility).toBe("");
  expect(screen.getByTestId("second").style.visibility).toBe("");
});

it("opens Chats by keyboard, dismisses with Escape, and restores focus", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <ChatRoomLayout
        variant="compact"
        sidebarWidth={250}
        setSidebarWidth={() => {}}
        sidebarVisible={open}
        setSidebarVisible={setOpen}
        totalUnread={0}
        sidebarContent={<button>Test thread</button>}
        chatContent={<input aria-label="Draft" />}
        onNewChat={() => {}}
        newChatSelected={false}
      />
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Chats" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Chats" });
  await waitFor(() =>
    expect(
      dialog.closest(".ant-drawer")?.contains(document.activeElement),
    ).toBe(true),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Chats" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("restores a custom phone trigger after the drawer is destroyed", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button
          ref={trigger}
          onClick={() => {
            trigger.current?.blur();
            setOpen(true);
          }}
        >
          Open chats
        </button>
        <ChatRoomLayout
          variant="compact"
          hideCompactNavigation
          sidebarWidth={250}
          setSidebarWidth={() => {}}
          sidebarVisible={open}
          setSidebarVisible={setOpen}
          onSidebarClosed={() => trigger.current?.focus()}
          totalUnread={0}
          sidebarContent={<button>Test thread</button>}
          chatContent={<input aria-label="Draft" />}
          onNewChat={() => {}}
          newChatSelected={false}
        />
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Open chats" });
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Chats" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "New Chat" })).toBe(
      document.activeElement,
    ),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
