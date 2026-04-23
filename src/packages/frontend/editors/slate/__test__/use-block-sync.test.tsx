import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { EventEmitter } from "events";
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

class FakeSyncstring extends EventEmitter {
  constructor(
    private getRemote: () => string,
    private isLiveConnected: () => boolean,
  ) {
    super();
  }

  to_str() {
    return this.getRemote();
  }

  get_state() {
    return "ready";
  }

  is_live_connected() {
    return this.isLiveConnected();
  }
}

type PendingRemoteHarnessRef = {
  blur: () => void;
  getValue: () => string;
};

function PendingRemoteHarness({
  actions,
  harnessRef,
}: {
  actions: any;
  harnessRef: React.RefObject<PendingRemoteHarnessRef | null>;
}) {
  const valueRef = useRef("local");
  const blocksRef = useRef(["local"]);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(0);

  useBlockSync({
    actions,
    value: "local",
    initialValue: "local",
    valueRef,
    blocksRef,
    focusedIndex,
    ignoreRemoteWhileFocused: true,
    setBlocksFromValue: (markdown) => {
      blocksRef.current = [markdown];
      valueRef.current = markdown;
    },
    getFullMarkdown: () => blocksRef.current.join(""),
  });

  useImperativeHandle(
    harnessRef,
    () => ({
      blur: () => setFocusedIndex(null),
      getValue: () => valueRef.current,
    }),
    [],
  );

  return null;
}

test("does not apply pending remote content on blur while syncstring is offline", async () => {
  let remote = "remote";
  let liveConnected = false;
  const syncstring = new FakeSyncstring(
    () => remote,
    () => liveConnected,
  );
  const harnessRef = React.createRef<PendingRemoteHarnessRef>();

  render(
    <PendingRemoteHarness
      actions={{ _syncstring: syncstring }}
      harnessRef={harnessRef}
    />,
  );

  await act(async () => {
    syncstring.emit("change");
  });
  expect(harnessRef.current?.getValue()).toBe("local");

  await act(async () => {
    harnessRef.current?.blur();
  });
  expect(harnessRef.current?.getValue()).toBe("local");

  liveConnected = true;
  await act(async () => {
    syncstring.emit("change");
  });
  expect(harnessRef.current?.getValue()).toBe("remote");
});
