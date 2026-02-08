/** @jest-environment jsdom */

import { useState } from "react";
import { act, render } from "@testing-library/react";
import ChatInput from "../input";

let lastMarkdownInputProps: any = null;

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => {
  const MockMarkdownInput = (props: any) => {
    lastMarkdownInputProps = props;
    return <div data-testid="mock-markdown-input" />;
  };
  return {
    __esModule: true,
    default: MockMarkdownInput,
  };
});

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ project_id: "project-1" }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => {
      if (name === "projects") {
        return {
          hasLanguageModelEnabled: () => false,
        };
      }
      return {
        get_account_id: () => "acct-1",
      };
    },
  },
}));

jest.mock("react-intl", () => ({
  defineMessage: (x) => x,
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

describe("ChatInput send lifecycle regressions", () => {
  beforeEach(() => {
    lastMarkdownInputProps = null;
    jest.useFakeTimers();
    jest.setSystemTime(1);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not resurrect just-sent text when a stale onChange arrives later", () => {
    const sent: string[] = [];
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
    } as any;

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ChatInput
          input={value}
          onChange={setValue}
          on_send={(v) => sent.push(v)}
          syncdb={syncdb}
          date={0}
        />
      );
    }

    render(<Harness />);
    expect(lastMarkdownInputProps).toBeTruthy();

    act(() => {
      lastMarkdownInputProps.onChange("hello");
    });
    expect(lastMarkdownInputProps.value).toBe("hello");

    act(() => {
      lastMarkdownInputProps.onShiftEnter("hello");
    });
    expect(sent).toEqual(["hello"]);
    expect(lastMarkdownInputProps.value).toBe("");

    // Simulate a late stale editor callback after send. This should be ignored.
    act(() => {
      jest.setSystemTime(2500);
      lastMarkdownInputProps.onChange("hello");
    });

    expect(lastMarkdownInputProps.value).toBe("");
  });
});
