/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockSubmitNavigatorPromptInWorkspaceChat = jest.fn();
const mockExec = jest.fn();
const mockAddHistoryEntry = jest.fn();
const mockSetFileSearch = jest.fn();

jest.mock("react-intl", () => ({
  defineMessage: (msg: any) => msg,
  defineMessages: (msgs: any) => msgs,
  createIntlCache: () => ({}),
  createIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage,
  }),
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage,
  }),
}));

jest.mock("antd", () => ({
  Alert: ({ title }: any) => <div>{title}</div>,
  Flex: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  SearchInput: ({ value, on_submit, on_change }: any) => (
    <div>
      <input
        data-testid="search-input"
        value={value}
        onChange={(e) => on_change(e.target.value)}
        readOnly
      />
      <button
        type="button"
        onClick={() =>
          on_submit(value, { ctrl_down: false, shift_down: false })
        }
      >
        submit
      </button>
    </div>
  ),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: "project-1" }),
}));

jest.mock("@cocalc/frontend/project/explorer/search-history-dropdown", () => ({
  SearchHistoryDropdown: () => null,
}));

jest.mock("@cocalc/frontend/project/explorer/use-search-history", () => ({
  useExplorerSearchHistory: () => ({
    history: [],
    initialized: true,
    addHistoryEntry: (...args: any[]) => mockAddHistoryEntry(...args),
  }),
}));

jest.mock(
  "@cocalc/frontend/project/explorer/file-listing/terminal-mode-display",
  () => ({
    TerminalModeDisplay: () => null,
  }),
);

jest.mock("@cocalc/frontend/project/explorer/file-listing/utils", () => ({
  isTerminalMode: (value: string) =>
    typeof value === "string" &&
    (value.startsWith("/") || value.startsWith("!")),
  isAgentMode: (value: string) =>
    typeof value === "string" && value.startsWith("@"),
  extractAgentPrompt: (value: string) =>
    typeof value === "string" && value.startsWith("@")
      ? value.slice(1).trim()
      : "",
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => 0,
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    exec: (...args: any[]) => mockExec(...args),
  },
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: (...args: any[]) =>
    mockSubmitNavigatorPromptInWorkspaceChat(...args),
}));

const { SearchBar } = require("./search-bar");

describe("SearchBar agent miniterm prefix", () => {
  beforeEach(() => {
    mockSubmitNavigatorPromptInWorkspaceChat.mockReset();
    mockSubmitNavigatorPromptInWorkspaceChat.mockResolvedValue(true);
    mockExec.mockReset();
    mockAddHistoryEntry.mockReset();
    mockSetFileSearch.mockReset();
  });

  it("routes @-prefixed input to the navigator agent instead of terminal exec", async () => {
    const actions = {
      set_file_search: (...args: any[]) => mockSetFileSearch(...args),
      clear_selected_file_index: jest.fn(),
      zero_selected_file_index: jest.fn(),
      setState: jest.fn(),
      setFlyoutExpanded: jest.fn(),
      open_directory: jest.fn(),
      log: jest.fn(),
    } as any;

    render(
      <SearchBar
        file_search="@fix this directory"
        current_path="/work"
        actions={actions}
        create_file={jest.fn()}
        create_folder={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() =>
      expect(mockSubmitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith({
        project_id: "project-1",
        prompt: "fix this directory",
        visiblePrompt: "fix this directory",
        path: "/work",
        tag: "intent:miniterm-agent",
        waitForAgent: false,
      }),
    );
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockAddHistoryEntry).toHaveBeenCalledWith("@fix this directory");
    expect(mockSetFileSearch).toHaveBeenLastCalledWith("");
  });
});
