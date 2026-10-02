import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import {
  ProjectsSearchDrawer,
  searchableProjects,
} from "./projects-search-drawer";

const openProject = jest.fn();
const run = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => {
  const { fromJS } = require("immutable");
  const projects = fromJS({
    p1: { title: "Thesis", last_active: { me: "2026-09-20" } },
    p2: { title: "Course", last_active: { me: "2026-09-01" } },
    p3: { title: "Old", state: { state: "archived" } },
  });
  return {
    redux: {
      getActions: () => ({ open_project: (...a) => openProject(...a) }),
    },
    useTypedRedux: (store: string, field: string) =>
      store === "projects"
        ? projects
        : field === "account_id"
          ? "me"
          : undefined,
  };
});
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("./file-search-runner", () => ({
  runProjectFileSearch: (...a) => run(...a),
}));

test("searchable projects: recent first, archived skipped", () => {
  const map = fromJS({
    a: { last_active: { me: "2026-01-01" } },
    b: { last_active: { me: "2026-02-01" } },
    c: { state: { state: "archived" } },
    d: { deleted: true },
  });
  expect(searchableProjects(map, "me")).toEqual(["b", "a"]);
});

it("searches, groups hits by project, reports unavailable ones, opens files", async () => {
  run.mockImplementation(async ({ project_ids, report }) => {
    const progress = {
      hits: [{ project_id: "p1", path: "chapters/intro.tex" }],
      searched: ["p1"],
      unavailable: ["p2"],
      pending: [],
      truncated: false,
    };
    report(progress);
    expect(project_ids).toEqual(["p1", "p2"]);
    return progress;
  });
  const user = userEvent.setup();
  const onClose = jest.fn();
  render(<ProjectsSearchDrawer open onClose={onClose} />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search file names in projects" }),
    "intro{Enter}",
  );
  const hit = await screen.findByRole("button", {
    name: /chapters\/intro\.tex/,
  });
  expect(screen.getByRole("region", { name: "Thesis" })).toContainElement(hit);
  expect(
    screen.getByText("1 project did not answer in time"),
  ).toBeInTheDocument();
  await user.click(hit);
  expect(openProject).toHaveBeenCalledWith({
    project_id: "p1",
    target: "files/chapters/intro.tex",
    switch_to: true,
  });
  expect(onClose).toHaveBeenCalled();
});

it("Search more continues with the projects not reached", async () => {
  run
    .mockImplementationOnce(async () => ({
      hits: [],
      searched: ["p1"],
      unavailable: [],
      pending: ["p2"],
      truncated: false,
    }))
    .mockImplementationOnce(async ({ project_ids }) => {
      expect(project_ids).toEqual(["p2"]);
      return {
        hits: [{ project_id: "p2", path: "x.md" }],
        searched: ["p2"],
        unavailable: [],
        pending: [],
        truncated: false,
      };
    });
  const user = userEvent.setup();
  render(<ProjectsSearchDrawer open onClose={jest.fn()} />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search file names in projects" }),
    "x{Enter}",
  );
  await user.click(
    await screen.findByRole("button", { name: "Search 1 more project" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /x\.md/ })).toBeInTheDocument(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 file in 1 of 2 projects searched",
  );
});
