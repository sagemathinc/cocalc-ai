/** @jest-environment jsdom */

import { useEffect, useRef, useState } from "react";
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

  it("does not resurrect just-sent text when a stale callback arrives from an old session", () => {
    const sent: string[] = [];
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
    } as any;

    function Harness() {
      const [value, setValue] = useState("");
      const [session, setSession] = useState(1);
      const sessionRef = useRef(session);
      useEffect(() => {
        sessionRef.current = session;
      }, [session]);

      const setComposerInput = (next: string, sessionToken?: number) => {
        if (sessionToken != null && sessionToken !== sessionRef.current) return;
        setValue(next);
      };

      return (
        <ChatInput
          input={value}
          onChange={setComposerInput}
          on_send={(v) => {
            sent.push(v);
            setSession((s) => s + 1);
            setValue("");
          }}
          syncdb={syncdb}
          date={0}
          sessionToken={session}
        />
      );
    }

    render(<Harness />);
    expect(lastMarkdownInputProps).toBeTruthy();

    act(() => {
      lastMarkdownInputProps.onChange("hello");
    });
    expect(lastMarkdownInputProps.value).toBe("hello");
    const staleOnChange = lastMarkdownInputProps.onChange;

    act(() => {
      lastMarkdownInputProps.onShiftEnter("hello");
    });
    expect(sent).toEqual(["hello"]);
    expect(lastMarkdownInputProps.value).toBe("");

    // Simulate a late stale editor callback from the previous session.
    act(() => {
      staleOnChange("hello");
    });

    expect(lastMarkdownInputProps.value).toBe("");
  });

  it("accepts live callbacks from the current session", () => {
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
          on_send={() => undefined}
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
  });
});
