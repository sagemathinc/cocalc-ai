import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentProjectStatus, projectStatusLabel } from "./project-status";
let liveTitle = "Development";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useProjectFromMap: () => ({
    get: (key) => (key === "title" ? liveTitle : undefined),
    getIn: () => "running",
  }),
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/project/use-project-run-quota", () => ({
  useProjectRunQuota: () => ({ runQuota: { network: true } }),
}));
jest.mock("@cocalc/frontend/projects/host-info", () => ({
  useHostInfo: () => undefined,
}));
jest.mock("@cocalc/frontend/projects/host-operational", () => ({
  normalizeProjectStateForDisplay: ({ projectState }) => projectState,
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("./project-details", () => ({
  __esModule: true,
  default: () => <div>Project controls</div>,
}));

test("distinguishes stopped projects, blocked internet, and unknown state", () => {
  expect(projectStatusLabel("opened")).toBe("Stopped");
  expect(projectStatusLabel("running", false)).toBe("Internet access blocked");
  expect(projectStatusLabel(undefined)).toBe("Status unknown");
});

test("opens project controls without navigation, resizes, and restores focus on Escape", async () => {
  liveTitle = "Development";
  render(
    <AgentProjectStatus agent={{ endpoint: { project_id: "p" } } as any} />,
  );
  const trigger = screen.getByRole("button", {
    name: "Project: Development · Running",
  });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Development" });
  expect(await screen.findByText("Project controls")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Resize" }));
  expect(localStorage.getItem("cocalc-agents-project-drawer-width")).toBe(
    "400",
  );
  fireEvent.keyDown(dialog, { key: "Escape", keyCode: 27 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("long live titles stay single-line and retain a full accessible name", () => {
  liveTitle = "A very long project title ".repeat(30).trim();
  const { rerender } = render(
    <AgentProjectStatus
      agent={{ endpoint: { project_id: "p" }, project_title: "stale" } as any}
    />,
  );
  const button = screen.getByRole("button", {
    name: `Project: ${liveTitle} · Running`,
  });
  expect(button).toHaveStyle({
    whiteSpace: "nowrap",
    minWidth: "0",
    height: "24px",
  });
  expect(button.querySelector("span")).toHaveStyle({
    textOverflow: "ellipsis",
    overflow: "hidden",
  });
  liveTitle = "Updated title";
  rerender(
    <AgentProjectStatus
      agent={{ endpoint: { project_id: "p" }, project_title: "stale" } as any}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Project: Updated title · Running" }),
  ).toBeVisible();
});
