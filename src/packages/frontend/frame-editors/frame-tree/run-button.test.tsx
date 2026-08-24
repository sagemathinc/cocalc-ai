/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span data-testid="icon">{name}</span>,
  Tooltip: ({ children }) => <>{children}</>,
  VisibleMDLG: ({ children }) => <>{children}</>,
}));

import RunButton from "./run-button";

function renderRun(props: any = {}) {
  const actions = { run_code: jest.fn() };
  render(
    <IntlProvider locale="en">
      <RunButton id="cm-1" path="dir/a.py" actions={actions} {...props} />
    </IntlProvider>,
  );
  return actions;
}

describe("RunButton", () => {
  it("is a button named Run, also when only the icon is shown", () => {
    renderRun({ noLabel: true });
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("runs the frame's file when clicked", () => {
    const actions = renderRun();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(actions.run_code).toHaveBeenCalledWith("cm-1", undefined);
  });

  it("runs the document of a subframe when there is one", () => {
    const documentActions = { path: "sub/inner.py" };
    const actions = renderRun({ documentActions, path: "sub/inner.py" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(actions.run_code).toHaveBeenCalledWith("cm-1", documentActions);
  });

  it("is keyboard operable: focus it and press Enter", () => {
    const actions = renderRun();
    const button = screen.getByRole("button", { name: "Run" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    // jsdom does not synthesize the click a real browser fires for Enter on a
    // native button, so assert the element really is a native button.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("disabled")).toBe(null);
    fireEvent.click(button);
    expect(actions.run_code).toHaveBeenCalled();
  });
});
