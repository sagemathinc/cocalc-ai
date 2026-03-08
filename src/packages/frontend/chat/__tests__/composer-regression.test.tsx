/** @jest-environment jsdom */

import { useEffect, useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import ChatInput, { ChatInputControl } from "../input";

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
      set_cursor_locs: jest.fn(),
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
      set_cursor_locs: jest.fn(),
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

  it("ignores stale callbacks from an unmounted input instance", () => {
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
      set_cursor_locs: jest.fn(),
    } as any;
    let setDraftKeyRef: ((n: number) => void) | null = null;

    function Harness() {
      const [value, setValue] = useState("");
      const [draftKey, setDraftKey] = useState(0);
      useEffect(() => {
        setDraftKeyRef = setDraftKey;
      }, [setDraftKey]);
      return (
        <ChatInput
          key={`draft-${draftKey}`}
          cacheId={`draft-${draftKey}`}
          input={value}
          onChange={setValue}
          on_send={() => undefined}
          syncdb={syncdb}
          date={draftKey}
          sessionToken={1}
        />
      );
    }

    render(<Harness />);
    expect(lastMarkdownInputProps).toBeTruthy();
    const staleOnChange = lastMarkdownInputProps.onChange;

    act(() => {
      setDraftKeyRef?.(1);
    });
    expect(lastMarkdownInputProps).toBeTruthy();
    expect(lastMarkdownInputProps.cacheId).toBe("draft-1");
    expect(lastMarkdownInputProps.value).toBe("");

    // Late callback from unmounted previous editor instance.
    act(() => {
      staleOnChange("ghost");
    });

    expect(lastMarkdownInputProps.cacheId).toBe("draft-1");
    expect(lastMarkdownInputProps.value).toBe("");
  });

  it("exposes a focus control that delegates to the editor control ref", () => {
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
      set_cursor_locs: jest.fn(),
    } as any;
    const inputControlRef = { current: null } as {
      current: ChatInputControl | null;
    };
    const focus = jest.fn(() => true);
    const allowNextValueUpdateWhileFocused = jest.fn();

    render(
      <ChatInput
        input="hello"
        onChange={() => undefined}
        on_send={() => undefined}
        syncdb={syncdb}
        date={0}
        inputControlRef={inputControlRef}
      />,
    );

    lastMarkdownInputProps.controlRef.current = {
      focus,
      allowNextValueUpdateWhileFocused,
    };

    expect(inputControlRef.current?.focus()).toBe(true);
    expect(allowNextValueUpdateWhileFocused).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("refocuses after send once the session advances and the draft clears", () => {
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
      set_cursor_locs: jest.fn(),
    } as any;
    const focus = jest.fn(() => true);

    function Harness() {
      const [value, setValue] = useState("");
      const [session, setSession] = useState(1);
      return (
        <ChatInput
          input={value}
          onChange={setValue}
          on_send={() => {
            setSession((current) => current + 1);
            setValue("");
          }}
          syncdb={syncdb}
          date={0}
          sessionToken={session}
        />
      );
    }

    render(<Harness />);
    lastMarkdownInputProps.controlRef.current = {
      focus,
      allowNextValueUpdateWhileFocused: jest.fn(),
    };

    act(() => {
      lastMarkdownInputProps.onChange("hello");
    });
    act(() => {
      lastMarkdownInputProps.onShiftEnter("hello");
    });
    act(() => {
      jest.runAllTimers();
    });

    expect(lastMarkdownInputProps.value).toBe("");
    expect(focus).toHaveBeenCalled();
  });

});
