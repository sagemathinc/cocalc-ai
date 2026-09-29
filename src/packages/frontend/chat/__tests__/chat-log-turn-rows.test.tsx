/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react";
import { ChatLog } from "../chat-log";
import { resolveChatViewportAnchorIndex } from "../chat-scroll-anchor";
import { useCodexLog } from "../use-codex-log";

let renderedMessages: any[] = [];
let latestVirtuosoProps: any;
const scrollToIndex = jest.fn();

jest.mock("../use-codex-log", () => ({ useCodexLog: jest.fn() }));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: (arg1: any, arg2?: string) => {
      if (arg1 === "page" && arg2 === "active_top_tab") return "project-1";
      if (
        typeof arg1 === "object" &&
        arg1?.project_id === "project-1" &&
        arg2 === "active_project_tab"
      ) {
        return "editor-thread.chat";
      }
      if (arg1 === "account" && arg2 === "account_id") return "acct-1";
      return undefined;
    },
  };
});

jest.mock("@cocalc/frontend/components/stateful-virtuoso", () => {
  const React = require("react");
  return React.forwardRef((props: any, ref: any) => {
    latestVirtuosoProps = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex,
      scrollIntoView: jest.fn(),
      getState: jest.fn(),
    }));
    return (
      <div data-testid="virtuoso">
        {Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
          <div key={props.computeItemKey(index, props.data[index])}>
            {props.itemContent?.(index, props.data?.[index], props.context)}
          </div>
        ))}
      </div>
    );
  });
});

jest.mock("@cocalc/frontend/jupyter/div-temp-height", () => ({
  DivTempHeight: ({ children }: any) => <>{children}</>,
}));

jest.mock("../drawer-overlay-state", () => ({
  setChatOverlayOpen: jest.fn(),
  useAnyChatOverlayOpen: () => false,
}));

jest.mock("../message", () => ({
  __esModule: true,
  default: (props: any) => {
    renderedMessages.push(props);
    return <div>{`message ${props.message?.message_id}`}</div>;
  },
}));

jest.mock("../composing", () => ({ __esModule: true, default: () => null }));

function liveLog(texts: string[]) {
  jest.mocked(useCodexLog).mockImplementation(({ enabled }: any) => ({
    events: enabled
      ? (texts
          .map((text, index) => [
            {
              type: "event",
              event: { type: "message", text },
              time: 1000 * (index + 1),
              seq: 2 * index + 1,
            },
            { type: "status", state: "running", seq: 2 * index + 2 },
          ])
          .flat() as any)
      : undefined,
    liveStatus: enabled ? "connected" : "idle",
    hasLogRef: true,
    loadState: "idle",
    deleteLog: jest.fn(),
  }));
}

function messages({ generating }: { generating: boolean }) {
  return new Map<string, any>([
    [
      "1000",
      {
        date: 1000,
        message_id: "user-1",
        thread_id: "thread-1",
        sender_id: "acct-1",
        history: [{ content: "Do the work" }],
      },
    ],
    [
      "2000",
      {
        date: 2000,
        message_id: "assistant-1",
        thread_id: "thread-1",
        parent_message_id: "user-1",
        sender_id: "acct-codex",
        acp_account_id: "acct-codex",
        generating,
        history: [{ content: generating ? ":robot: Thinking..." : "Done." }],
      },
    ],
  ]);
}

function Chat({ generating }: { generating: boolean }) {
  return (
    <ChatLog
      project_id="project-1"
      path="thread.chat"
      mode="standalone"
      actions={{ clearScrollRequest: jest.fn() } as any}
      selectedThread="thread-1"
      messages={messages({ generating })}
    />
  );
}

function lastProps(messageId: string) {
  return [...renderedMessages]
    .reverse()
    .find((props) => props.message?.message_id === messageId);
}

beforeEach(() => {
  renderedMessages = [];
  scrollToIndex.mockClear();
});

test("a live turn's activity rows are list rows before the agent's message", async () => {
  liveLog(["Reading the code.", "Running the tests."]);
  render(<Chat generating />);
  await act(async () => {});
  expect(latestVirtuosoProps.data.map(({ key }) => key)).toEqual([
    "1000",
    "2000#agent:0:0",
    "2000#agent:1:0",
    "2000",
    "end",
  ]);
  expect(screen.getByText("Reading the code.")).toBeTruthy();
  expect(screen.getByText("Running the tests.")).toBeTruthy();
  // The list feeds the turn; the message neither loads the log nor renders
  // the rows itself.
  expect(lastProps("assistant-1").activityFeed).toBe(true);
  expect(lastProps("user-1").activityFeed).toBe(false);
  expect(screen.getAllByRole("button", { name: "Copy block" })).toHaveLength(2);
});

test("expanding completed activity inserts its rows and scrolls to them", async () => {
  liveLog(["Reading the code.", "Done."]);
  render(<Chat generating={false} />);
  await act(async () => {});
  expect(latestVirtuosoProps.data.map(({ key }) => key)).toEqual([
    "1000",
    "2000",
    "end",
  ]);
  expect(lastProps("assistant-1").activityFeed).toBe(false);
  await act(async () => {
    lastProps("assistant-1").onExpandedCodexActivityChange(true);
  });
  await act(async () => {});
  const keys = latestVirtuosoProps.data.map(({ key }) => key);
  expect(keys).toEqual([
    "1000",
    "2000#agent:0:0",
    "2000#agent:1:0",
    "2000",
    "end",
  ]);
  expect(scrollToIndex).toHaveBeenCalledWith(
    expect.objectContaining({ index: 1, align: "start" }),
  );
});

test("reading anchors on activity rows fall back to their turn", () => {
  const keys = ["1000", "2000#agent:0:0", "2000#agent:1:0", "2000", "3000"];
  expect(
    resolveChatViewportAnchorIndex(
      { atBottom: false, date: "2000#agent:1:0", offsetPx: 0, savedAt: 0 },
      keys,
    ),
  ).toBe(2);
  // The row no longer exists (e.g. activity was hidden): use the turn.
  expect(
    resolveChatViewportAnchorIndex(
      { atBottom: false, date: "2000#agent:7:0", offsetPx: 0, savedAt: 0 },
      ["1000", "2000", "3000"],
    ),
  ).toBe(1);
});

test("the streaming tail row shows new text in place", async () => {
  liveLog(["Reading the code.", "Running the"]);
  const { rerender } = render(<Chat generating />);
  await act(async () => {});
  const keys = latestVirtuosoProps.data.map(({ key }) => key);
  liveLog(["Reading the code.", "Running the tests now."]);
  rerender(<Chat generating />);
  await act(async () => {});
  expect(screen.getByText("Running the tests now.")).toBeTruthy();
  expect(screen.queryByText("Running the")).toBeNull();
  expect(latestVirtuosoProps.data.map(({ key }) => key)).toEqual(keys);
});
