/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { usePreservedScroll } from "./use-preserved-scroll";

function Harness() {
  const [selection, setSelection] = useState<object>({});
  const [ready, setReady] = useState(true);
  const { elementRef, onScroll } = usePreservedScroll(selection, ready);
  return (
    <>
      <button
        onClick={() => {
          setReady(false);
          setSelection({});
        }}
      >
        Change version
      </button>
      <button onClick={() => setReady(true)}>Finish loading</button>
      <div data-testid="scroll" onScroll={onScroll} ref={elementRef} />
    </>
  );
}

test("restores the previous offset after the selected version loads", () => {
  render(<Harness />);
  const scroll = screen.getByTestId("scroll");
  scroll.scrollTop = 240;
  fireEvent.scroll(scroll);

  fireEvent.click(screen.getByRole("button", { name: "Change version" }));
  // A short loading view clamps the browser's scroll container.
  scroll.scrollTop = 0;
  fireEvent.scroll(scroll);
  fireEvent.click(screen.getByRole("button", { name: "Finish loading" }));

  expect(scroll.scrollTop).toBe(240);
});
