import { render, screen } from "@testing-library/react";
import { ProjectsSearchDrawer } from "./projects-search-drawer";

jest.mock("./filename-search", () => ({
  FilenameSearch: () => <input aria-label="Search for filenames" />,
}));

test("Search projects searches file names across projects", () => {
  const { rerender } = render(
    <ProjectsSearchDrawer open={false} onClose={() => {}} />,
  );
  expect(screen.queryByLabelText("Search for filenames")).toBeNull();
  rerender(<ProjectsSearchDrawer open onClose={() => {}} />);
  expect(screen.getByText("Search projects")).toBeInTheDocument();
  expect(screen.getByLabelText("Search for filenames")).toBeInTheDocument();
});
