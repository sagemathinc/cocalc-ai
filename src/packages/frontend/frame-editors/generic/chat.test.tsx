/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
import { chat } from "./chat";

const mockGetChatActions = jest.fn();
const mockInitChat = jest.fn();
const mockUseFrameContext = jest.fn();
const mockSideChat = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getEditorActions: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: (...args: any[]) => mockGetChatActions(...args),
  initChat: (...args: any[]) => mockInitChat(...args),
}));

jest.mock("@cocalc/frontend/chat/side-chat", () => ({
  __esModule: true,
  default: (props: any) => {
    mockSideChat(props);
    return <div data-testid="side-chat">{props.actions?.__id}</div>;
  },
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => mockUseFrameContext(),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    chat: "Chat",
  },
}));

jest.mock("@cocalc/frontend/chat/paths", () => ({
  chatMetaFile: (path: string) => `${path}.sage-chat`,
}));

jest.mock("@cocalc/frontend/frame-editors/chat-editor/editor", () => ({
  chatroom: { commands: {} },
}));

function createMockChatActions(id: string, initialState = "ready") {
  let state = initialState;
  const onceHandlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    __id: id,
    frameTreeActions: undefined,
    frameId: "",
    syncdb: {
      get_state: jest.fn(() => state),
      once: jest.fn((event: string, cb: (...args: any[]) => void) => {
        const handlers = onceHandlers.get(event) ?? new Set();
        handlers.add(cb);
        onceHandlers.set(event, handlers);
      }),
      removeListener: jest.fn((event: string, cb: (...args: any[]) => void) => {
        onceHandlers.get(event)?.delete(cb);
      }),
      emitClose: () => {
        state = "closed";
        for (const cb of Array.from(onceHandlers.get("close") ?? [])) {
          cb();
        }
        onceHandlers.get("close")?.clear();
      },
    },
  } as any;
}

describe("generic side chat editor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFrameContext.mockReturnValue({
      project_id: "project-1",
      path: "/home/user/notes.md",
      actions: { kind: "frame-actions" },
      id: "frame-1",
    });
  });

  it("recreates side chat actions after the syncdb closes", async () => {
    const firstActions = createMockChatActions("first");
    const secondActions = createMockChatActions("second");
    mockGetChatActions.mockReturnValue(undefined);
    mockInitChat
      .mockReturnValueOnce(firstActions)
      .mockReturnValueOnce(secondActions);

    const Component = chat.component as any;
    render(<Component font_size={13} desc={{}} />);

    await waitFor(() => expect(screen.getByTestId("side-chat")).toBeTruthy());
    expect(screen.getByText("first")).toBeTruthy();
    expect(firstActions.frameTreeActions).toEqual({ kind: "frame-actions" });
    expect(firstActions.frameId).toBe("frame-1");

    act(() => {
      firstActions.syncdb.emitClose();
    });

    await waitFor(() => expect(mockInitChat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    expect(secondActions.frameTreeActions).toEqual({ kind: "frame-actions" });
    expect(secondActions.frameId).toBe("frame-1");
  });
});
