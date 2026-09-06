/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";

import { PANEL_STYLE, SnapToggleButton } from "./panel";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const set_frame_tree = jest.fn();
const useFrameContext = jest.fn();

jest.mock("../hooks", () => ({
  useFrameContext: (...args: any[]) => useFrameContext(...args),
}));

function mountWith(snapToAlignment?: boolean) {
  set_frame_tree.mockClear();
  useFrameContext.mockReturnValue({
    actions: { set_frame_tree },
    id: "frame-1",
    desc: fromJS(
      snapToAlignment == null ? {} : { snapToAlignment: snapToAlignment },
    ),
  });
  return render(<SnapToggleButton />);
}

describe("SnapToggleButton accessibility", () => {
  it("pairs floating tool surfaces with themed foregrounds", () => {
    expect(PANEL_STYLE.background).toBe(UI_COLORS.elevated);
    expect(PANEL_STYLE.color).toBe(UI_COLORS.text);
  });
  it("exposes an accessible name that does not depend on the tooltip", () => {
    mountWith();
    // The icon is aria-hidden, so without an explicit label this control would
    // be nameless to assistive tech.
    expect(
      screen.getByRole("button", { name: "Snap to alignment" }),
    ).toBeTruthy();
  });

  it("exposes its on/off state via aria-pressed, not only via colour", () => {
    mountWith();
    // Snapping defaults to on when the frame description says nothing.
    expect(
      screen.getByRole("button", { name: "Snap to alignment" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("reports aria-pressed=false when snapping is disabled", () => {
    mountWith(false);
    expect(
      screen.getByRole("button", { name: "Snap to alignment" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("is keyboard operable and toggles the frame setting off", () => {
    mountWith(true);
    const button = screen.getByRole("button", { name: "Snap to alignment" });
    button.focus();
    expect(document.activeElement).toBe(button);
    // antd Button is a native <button>, so Enter/Space activate it via click.
    fireEvent.click(button);
    expect(set_frame_tree).toHaveBeenCalledWith({
      id: "frame-1",
      snapToAlignment: false,
    });
  });

  it("toggles back on from the disabled state", () => {
    mountWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Snap to alignment" }));
    expect(set_frame_tree).toHaveBeenCalledWith({
      id: "frame-1",
      snapToAlignment: true,
    });
  });
});
