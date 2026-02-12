import { fireEvent, render, screen } from "@testing-library/react";

import HomePageButton from "./button";

const mockActions = {
  set_active_tab: jest.fn(),
  setFlyoutExpanded: jest.fn(),
  set_file_search: jest.fn(),
  set_current_path: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useActions: () => mockActions,
}));

jest.mock("@cocalc/frontend/user-tracking", () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe("HomePageButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens the overview home page and does not reset filesystem path", () => {
    render(<HomePageButton project_id="p" active={false} width={48} />);
    fireEvent.click(screen.getByRole("button"));

    expect(mockActions.set_active_tab).toHaveBeenCalledWith("home");
    expect(mockActions.setFlyoutExpanded).toHaveBeenCalledWith(
      "files",
      false,
      false,
    );
    expect(mockActions.set_file_search).toHaveBeenCalledWith("");
    expect(mockActions.set_current_path).not.toHaveBeenCalled();
  });
});
