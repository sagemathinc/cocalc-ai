import { fireEvent, render, screen } from "@testing-library/react";

import HomePageButton from "./button";

const mockActions = {
  set_active_tab: jest.fn(),
  setFlyoutExpanded: jest.fn(),
  set_file_search: jest.fn(),
  set_current_path: jest.fn(),
  open_directory: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useActions: () => mockActions,
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));

describe("HomePageButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens the full-page files explorer at project home", () => {
    render(<HomePageButton project_id="p" active={false} width={48} />);
    fireEvent.click(screen.getByRole("button"));

    expect(mockActions.open_directory).toHaveBeenCalledWith("/home/user");
    expect(mockActions.setFlyoutExpanded).toHaveBeenCalledWith(
      "files",
      false,
      false,
    );
    expect(mockActions.set_file_search).toHaveBeenCalledWith("");
    expect(mockActions.set_current_path).not.toHaveBeenCalled();
    expect(mockActions.set_active_tab).not.toHaveBeenCalled();
  });
});
