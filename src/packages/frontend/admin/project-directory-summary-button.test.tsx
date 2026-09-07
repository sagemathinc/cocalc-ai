import { fireEvent, render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ProjectDirectorySummaryButton } from "./project-directory-summary-button";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getAdminProjectDirectorySummary: jest.fn().mockResolvedValue({
            root: "/home/user",
            entries: [{ type: "file", path: "example.txt", size: 0 }],
          }),
        },
      },
    },
  },
}));

it("pairs directory output foreground and background appearance tokens", async () => {
  render(<ProjectDirectorySummaryButton project_id="example" />);
  fireEvent.click(screen.getByRole("button", { name: "Directory summary" }));
  const output = await screen.findByText(/file\s+example\.txt/);
  expect(output.tagName).toBe("PRE");
  expect(output).toHaveStyle({
    background: UI_COLORS.surface,
    color: UI_COLORS.text,
  });
});
