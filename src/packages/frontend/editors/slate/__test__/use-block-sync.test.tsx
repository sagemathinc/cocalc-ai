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
