/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import useEditCheckpoint from "./use-edit-checkpoint";

function Harness({
  active = true,
  revision,
  save,
}: {
  active?: boolean;
  revision: number;
  save: () => void;
}) {
  useEditCheckpoint({ active, revision, save });
  return null;
}

describe("useEditCheckpoint", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("checkpoints ten seconds after the most recent edit", () => {
    const save = jest.fn();
    const view = render(<Harness revision={0} save={save} />);
    act(() => jest.advanceTimersByTime(9_000));
    view.rerender(<Harness revision={1} save={save} />);
    act(() => jest.advanceTimersByTime(9_999));
    expect(save).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("checkpoints continuous editing after thirty seconds", () => {
    const save = jest.fn();
    const view = render(<Harness revision={0} save={save} />);
    for (let revision = 1; revision <= 3; revision += 1) {
      act(() => jest.advanceTimersByTime(9_000));
      view.rerender(<Harness revision={revision} save={save} />);
    }
    act(() => jest.advanceTimersByTime(2_999));
    expect(save).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
  });
});
