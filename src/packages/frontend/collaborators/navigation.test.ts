const setState = jest.fn();
const setActiveTab = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ setState, set_active_tab: setActiveTab }) },
}));
import { openCollaborators } from "./navigation";

test("opening Collaborators hides Library without selecting or invoking an agent", () => {
  openCollaborators({
    view: "people",
    personId: "person-1",
    projectId: "project-1",
  });
  expect(setState).toHaveBeenCalledWith(
    expect.objectContaining({
      library_open: false,
      collaborators_open: true,
      collaborators_view: "people",
      collaborators_person_id: "person-1",
      collaborators_project_id: "project-1",
    }),
  );
  expect(setState.mock.calls[0][0]).not.toHaveProperty("active_agent_id");
  expect(setActiveTab).toHaveBeenCalledWith("agents");
});
