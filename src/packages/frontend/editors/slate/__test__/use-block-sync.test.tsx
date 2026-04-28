import React, { useEffect, useRef } from "react";
import { EventEmitter } from "events";
import { render } from "@testing-library/react";
import { useBlockSync } from "../use-block-sync";

function DebouncedSaveHarness({ actions }: { actions: any }) {
  const didScheduleRef = useRef(false);
  const valueRef = useRef("old");
  const blocksRef = useRef(["old"]);

  const sync = useBlockSync({
    actions,
    value: "old",
    initialValue: "old",
    valueRef,
    blocksRef,
    focusedIndex: 0,
    setBlocksFromValue: (markdown) => {
      blocksRef.current = [markdown];
      valueRef.current = markdown;
    },
    getFullMarkdown: () => blocksRef.current.join(""),
  });

  useEffect(() => {
    if (didScheduleRef.current) return;
    didScheduleRef.current = true;
    blocksRef.current = ["new"];
    sync.markLocalEdit();
    sync.saveBlocksDebounced();
  }, [sync]);

  return null;
}

test("flushes a pending debounced block-editor save on unmount", () => {
  const actions = {
    set_value: jest.fn(),
    syncstring_commit: jest.fn(),
  };
  const { unmount } = render(<DebouncedSaveHarness actions={actions} />);

  expect(actions.set_value).not.toHaveBeenCalled();

  unmount();

  expect(actions.set_value).toHaveBeenCalledWith("new");
  expect(actions.syncstring_commit).toHaveBeenCalled();
});

function FocusReplayHarness({
  focusedIndex,
  actions,
  observedMarkdownRef,
}: {
  focusedIndex: number | null;
  actions: any;
  observedMarkdownRef: React.MutableRefObject<string>;
}) {
  const valueRef = useRef("old");
  const blocksRef = useRef(["new"]);

  useBlockSync({
    actions,
    value: "old",
    initialValue: "old",
    valueRef,
    blocksRef,
    focusedIndex,
    setBlocksFromValue: (markdown) => {
      blocksRef.current = [markdown];
      valueRef.current = markdown;
      observedMarkdownRef.current = markdown;
    },
    getFullMarkdown: () => blocksRef.current.join(""),
  });

  useEffect(() => {
    valueRef.current = "new";
    observedMarkdownRef.current = blocksRef.current.join("");
  }, [observedMarkdownRef]);

  return null;
}

test("does not replay a stale value prop when blur changes focus before parent value catches up", () => {
  const observedMarkdownRef = { current: "" };
  const actions = {
    set_value: jest.fn(),
    syncstring_commit: jest.fn(),
  };
  const { rerender } = render(
    <FocusReplayHarness
      focusedIndex={0}
      actions={actions}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );

  expect(observedMarkdownRef.current).toBe("new");

  rerender(
    <FocusReplayHarness
      focusedIndex={null}
      actions={actions}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );

  expect(observedMarkdownRef.current).toBe("new");
});

function OutOfOrderEchoHarness({
  stage,
  syncstring,
  observedMarkdownRef,
}: {
  stage: number;
  syncstring: EventEmitter & { to_str: () => string };
  observedMarkdownRef: React.MutableRefObject<string>;
}) {
  const valueRef = useRef("hello");
  const blocksRef = useRef(["hello"]);

  const sync = useBlockSync({
    actions: {
      _syncstring: syncstring,
      set_value: (value: string) => {
        syncstring.to_str = () => value;
      },
      syncstring_commit: jest.fn(),
    },
    value: "hello",
    initialValue: "hello",
    valueRef,
    blocksRef,
    focusedIndex: 0,
    setBlocksFromValue: (markdown) => {
      blocksRef.current = [markdown];
      valueRef.current = markdown;
      observedMarkdownRef.current = markdown;
    },
    getFullMarkdown: () => blocksRef.current.join(""),
  });

  useEffect(() => {
    observedMarkdownRef.current = blocksRef.current.join("");
  });

  useEffect(() => {
    if (stage === 1) {
      blocksRef.current = ["hello world"];
      observedMarkdownRef.current = "hello world";
      sync.markLocalEdit();
      sync.saveBlocksNow();
      return;
    }
    if (stage === 2) {
      blocksRef.current = ["hello world again"];
      observedMarkdownRef.current = "hello world again";
      sync.markLocalEdit();
      sync.saveBlocksNow();
      return;
    }
    if (stage === 3) {
      syncstring.to_str = () => "hello world";
      syncstring.emit("change");
      observedMarkdownRef.current = blocksRef.current.join("");
    }
  }, [stage, sync, syncstring, observedMarkdownRef]);

  return null;
}

test("ignores an out-of-order syncstring echo after a newer local save", () => {
  const syncstring = new EventEmitter() as EventEmitter & {
    to_str: () => string;
  };
  syncstring.to_str = () => "hello";
  const observedMarkdownRef = { current: "" };

  const { rerender } = render(
    <OutOfOrderEchoHarness
      stage={0}
      syncstring={syncstring}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );

  rerender(
    <OutOfOrderEchoHarness
      stage={1}
      syncstring={syncstring}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );
  expect(observedMarkdownRef.current).toBe("hello world");

  rerender(
    <OutOfOrderEchoHarness
      stage={2}
      syncstring={syncstring}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );
  expect(observedMarkdownRef.current).toBe("hello world again");

  rerender(
    <OutOfOrderEchoHarness
      stage={3}
      syncstring={syncstring}
      observedMarkdownRef={observedMarkdownRef}
    />,
  );

  expect(observedMarkdownRef.current).toBe("hello world again");
});
