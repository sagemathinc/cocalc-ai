/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { ArchivedProjectNotice } from "./archived-project-notice";

function renderNotice(canStart: boolean, onStart = jest.fn()) {
  render(
    <IntlProvider locale="en">
      <ArchivedProjectNotice
        projectLabelLower="project"
        canStart={canStart}
        onStart={onStart}
      />
    </IntlProvider>,
  );
  return onStart;
}

describe("ArchivedProjectNotice", () => {
  it("offers Start to users who can run the project", () => {
    const onStart = renderNotice(true);
    expect(screen.getByText("This project is archived.")).toBeTruthy();
    fireEvent.click(screen.getByText("Start this project"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("explains the archive to viewers without an action", () => {
    renderNotice(false);
    expect(screen.getByText("This project is archived.")).toBeTruthy();
    expect(screen.queryByText("Start this project")).toBeNull();
    expect(
      screen.getByText(/until an owner or collaborator starts the project/),
    ).toBeTruthy();
  });
});
