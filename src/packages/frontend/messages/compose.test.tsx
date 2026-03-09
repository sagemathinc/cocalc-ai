/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import Compose from "./compose";

let latestMarkdownInputProps: any = null;

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Flex: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Input: ({ onChange, onFocus, onKeyDown, value, ...props }: any) => (
    <input
      {...props}
      value={value ?? ""}
      onChange={onChange}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    />
  ),
  Modal: ({ children }: any) => <div>{children}</div>,
  Space: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Spin: () => <span data-testid="spin" />,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("react-intl", () => ({
  defineMessage: (x: any) => x,
  defineMessages: (x: any) => x,
  FormattedMessage: ({ defaultMessage }: any) => <>{defaultMessage}</>,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }) => defaultMessage ?? "",
  }),
}));

jest.mock("use-debounce", () => ({
  useDebouncedCallback: (fn: (...args: any[]) => any) => {
    const wrapped: any = (...args: any[]) => fn(...args);
    wrapped.cancel = jest.fn();
    wrapped.flush = jest.fn();
    return wrapped;
  },
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(() => ({ setState: jest.fn() })),
    getStore: jest.fn(() => ({
      get: jest.fn(() => "messages-sent"),
    })),
  },
  useActions: jest.fn(() => ({
    updateDraft: jest.fn(),
    createDraft: jest.fn(async () => 1),
    mark: jest.fn(),
  })),
  useTypedRedux: jest.fn((_store: string, key: string) => {
    if (key === "fontSize") return 14;
    if (key === "compose") return false;
    return undefined;
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Paragraph: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span data-testid="icon" />,
}));

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    latestMarkdownInputProps = props;
    return <div data-testid="message-compose-editor" />;
  },
}));

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: jest.fn(() => 0),
  },
}));

jest.mock("./select-users", () => ({
  __esModule: true,
  default: () => <div data-testid="select-users" />,
}));

jest.mock("./zoom", () => ({
  __esModule: true,
  default: () => <div data-testid="zoom" />,
}));

describe("messages compose editor", () => {
  beforeEach(() => {
    latestMarkdownInputProps = null;
  });

  it("uses local undo and redo for the embedded markdown editor", () => {
    render(<Compose />);

    expect(latestMarkdownInputProps).toBeTruthy();
    expect(latestMarkdownInputProps.undoMode).toBe("local");
    expect(latestMarkdownInputProps.redoMode).toBe("local");
  });

  it("does not render the old version slider UI", () => {
    render(<Compose />);

    expect(screen.queryByRole("slider")).toBeNull();
  });
});
