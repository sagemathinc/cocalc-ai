import React, { useEffect, useRef } from "react";
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
