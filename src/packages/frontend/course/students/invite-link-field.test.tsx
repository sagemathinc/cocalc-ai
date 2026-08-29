/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { CourseInviteLinkField } from "./invite-link-field";

describe("CourseInviteLinkField", () => {
  it("reveals a selectable link and exposes a named copy action", () => {
    const onCopy = jest.fn();
    const value = "https://cocalc.ai/invites/example";
    render(<CourseInviteLinkField onCopy={onCopy} value={value} />);

    const input = screen.getByRole("textbox", { name: "Invite link" });
    expect(input).toHaveValue(value);

    input.focus();
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", value.length);

    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
