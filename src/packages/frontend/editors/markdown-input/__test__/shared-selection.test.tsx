/** @jest-environment jsdom */

import { useRef } from "react";
import { render } from "@testing-library/react";
import { useMultimodeModeState } from "../use-multimode-mode-state";
import { useMultimodeSelection } from "../use-multimode-selection";

jest.mock("@cocalc/frontend/misc", () => ({
  get_local_storage: () => undefined,
  set_local_storage: () => undefined,
}));

function Editor({ cacheId, controller }: { cacheId: string; controller: any }) {
  const { mode, getCachedSelection, saveCachedSelection } =
    useMultimodeModeState({ cacheId, fallbackMode: "editor" });
  const richTextControlRef = useRef(null);
  const { selectionRef } = useMultimodeSelection({
    cacheId,
    mode,
    getCachedSelection,
    saveCachedSelection,
    richTextControlRef,
  });
  selectionRef.current = controller;
  return null;
}

function controller(position: number) {
  const state = { position };
  return {
    getSelection: () => state.position,
    setSelection: jest.fn((next: number) => {
      state.position = next;
    }),
    type: () => {
      state.position += 1;
    },
  };
}

it("does not restore another mounted composer's cursor on draft updates", () => {
  const agent = controller(0);
  const chat = controller(10);
  const views = () => (
    <>
      <Editor cacheId="shared-draft" controller={agent} />
      <Editor cacheId="shared-draft" controller={chat} />
    </>
  );
  const { rerender } = render(views());
  for (let i = 0; i < 3; i++) {
    chat.type();
    rerender(views());
    expect(chat.getSelection()).toBe(11 + i);
    expect(chat.setSelection).not.toHaveBeenCalled();
    expect(agent.getSelection()).toBe(0);
  }
});

it("still restores a cached cursor when an editor remounts", () => {
  const original = controller(7);
  const { unmount } = render(
    <Editor cacheId="remount" controller={original} />,
  );
  unmount();
  const next = controller(0);
  render(<Editor cacheId="remount" controller={next} />);
  expect(next.getSelection()).toBe(7);
});
