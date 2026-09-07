/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { PathLink } from "./path-link";
import ActionAssist from "./action-assist";

jest.mock("../project/history/utils", () => ({
  handleFileEntryClick: jest.fn(),
}));
jest.mock("./tip", () => ({ Tip: ({ children }) => children }));
jest.mock("@cocalc/frontend/components", () => ({
  Paragraph: ({ children }) => <p>{children}</p>,
}));

it("uses theme foregrounds for activity paths and dimmed extensions", () => {
  const { rerender } = render(
    <PathLink project_id="project" path="notes.txt" dimExtensions />,
  );
  expect(screen.getByText("notes").style.color).toBe(UI_COLORS.text);
  expect(screen.getByText(".txt").style.color).toBe(UI_COLORS.secondary);
  rerender(
    <PathLink
      project_id="project"
      path="notes.txt"
      style={{ color: "white" }}
    />,
  );
  expect(screen.getByText("notes").style.color).toBe("white");
  expect(screen.getByText(".txt").style.color).toBe("");
});

it("pairs the CLI/Agent panel background with a themed foreground", () => {
  const { container } = render(
    <ActionAssist title="Use CLI or Agent" cliCommands={["cocalc --help"]} />,
  );
  const panel = container.firstElementChild as HTMLElement;
  expect(panel.style.background).toBe(UI_COLORS.inset);
  expect(panel.style.color).toBe(UI_COLORS.text);
  expect(screen.getByRole("button", { name: "CLI" })).toBeEnabled();
});
