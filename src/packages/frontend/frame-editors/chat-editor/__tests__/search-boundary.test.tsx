/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { search } from "../search";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";

const mockEraseActiveKeyHandler = jest.fn();
const searchIndexState = {
  error: "",
  setError: jest.fn(),
  index: undefined,
  doRefresh: jest.fn(),
  fragmentKey: "chat",
  isIndexing: false,
};

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: jest.fn(),
}));

jest.mock(
  "@cocalc/frontend/frame-editors/generic/search/use-search-index",
  () => jest.fn(() => searchIndexState),
);

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: ({ date }: { date: number }) => <span>{date}</span>,
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("antd", () => {
  const Card = ({ children }: any) => <div>{children}</div>;
  const InputBase = ({ value, onChange, allowClear, ...props }: any) => (
    <input value={value ?? ""} onChange={(e) => onChange?.(e)} {...props} />
  );
  const InputSearch = ({
    value,
    onChange,
    onSearch,
    allowClear,
    ...props
  }: any) => (
    <input
      data-testid="chat-search-input"
      value={value ?? ""}
      onChange={(e) => onChange?.(e)}
      onKeyDown={(e: any) => {
        if (e.key === "Enter") onSearch?.((e.target as HTMLInputElement).value);
      }}
      {...props}
    />
  );
  const Select = ({ value, onChange, options = [] }: any) => (
    <select
      data-testid="thread-scope-select"
      value={value ?? ""}
      onChange={(e) => onChange?.((e.target as HTMLSelectElement).value)}
    >
      {options.map((opt: any) => (
        <option key={String(opt.value)} value={String(opt.value)}>
          {String(opt.label)}
        </option>
      ))}
    </select>
  );
  return {
    Card,
    Input: Object.assign(InputBase, { Search: InputSearch }),
    Select,
  };
});

describe("chat search keyboard boundary", () => {
  const useFrameContextMock = useFrameContext as jest.Mock;
  const messages = new Map();
  const threadIndex = new Map();
  const chatActions = {
    getAllMessages: () => messages,
    getThreadIndex: () => threadIndex,
    listThreadConfigRows: () => [],
    getThreadMetadata: () => ({}),
    messageCache: undefined,
  };
  const frameActions = {
    getChatActions: () => chatActions,
  };

  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
    searchIndexState.setError.mockClear();
    searchIndexState.doRefresh.mockClear();
    useFrameContextMock.mockReturnValue({
      actions: frameActions,
      path: "lite2.chat",
      id: "frame-search-1",
      project_id: "project-1",
    });
  });

  it("clears page key handlers when the search input is focused", () => {
    const Component = search.component as any;
    render(
      <Component
        font_size={14}
        desc={{
          get: () => undefined,
        }}
      />,
    );

    expect(
      document.querySelector('[data-cocalc-keyboard-boundary="chat-search"]'),
    ).toBeTruthy();

    fireEvent.focus(screen.getByTestId("chat-search-input"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });

  it("allows typing into the search input before submitting", () => {
    const Component = search.component as any;
    render(
      <Component
        font_size={14}
        desc={{
          get: () => undefined,
        }}
      />,
    );

    const input = screen.getByTestId("chat-search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });

    expect(input.value).toBe("hello");
  });
});
