/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { StudentNotJoinedLabel } from "./not-joined-label";

function renderLabel(invitePending: boolean) {
  return render(
    <IntlProvider locale="en">
      <StudentNotJoinedLabel invitePending={invitePending} />
    </IntlProvider>,
  );
}

describe("StudentNotJoinedLabel", () => {
  it("says the invitation is pending rather than that no account exists", () => {
    renderLabel(true);
    expect(
      screen.getByText("(invitation not accepted yet)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/created account/)).toBeNull();
  });

  it("uses neutral wording when no invitation is known", () => {
    renderLabel(false);
    expect(screen.getByText("(has not joined yet)")).toBeInTheDocument();
    expect(screen.queryByText(/created account/)).toBeNull();
  });
});
