import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CourseVmRecommendationsEditor } from "./course-vm-recommendations";
import { catalog, template } from "./test/course-vm-template-fixture";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
const course = { course_project_id: "project", course_instance_id: "course" };
function service() {
  return {
    getCourseVmRecommendations: jest
      .fn()
      .mockResolvedValue({ templates: [], version: 0 }),
    setCourseVmRecommendations: jest
      .fn()
      .mockImplementation(async ({ templates }) => ({ templates, version: 1 })),
  };
}
it("connects load, keyboard editing and explicit versioned save without financial calls", async () => {
  const api = service();
  const user = userEvent.setup();
  render(
    <CourseVmRecommendationsEditor
      {...course}
      api={api}
      getCatalog={async () => catalog}
    />,
  );
  const add = screen.getByRole("button", { name: "Add recommendation" });
  await waitFor(() => expect(add).toBeEnabled());
  expect(api.getCourseVmRecommendations).toHaveBeenCalledWith(course);
  expect(api.setCourseVmRecommendations).not.toHaveBeenCalled();
  add.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Edit recommendation" }),
    ).toHaveFocus(),
  );
  await user.tab();
  await user.type(
    screen.getByRole("textbox", { name: "Recommendation label" }),
    "Notebook CPU",
  );
  await user.click(
    screen.getByRole("button", { name: "Apply recommendation" }),
  );
  expect(api.setCourseVmRecommendations).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Save recommendations" }),
  );
  await screen.findByText("Recommendations saved");
  expect(api.setCourseVmRecommendations).toHaveBeenCalledWith({
    ...course,
    expected_version: 0,
    templates: [
      expect.objectContaining({
        label: "Notebook CPU",
        config: expect.objectContaining(template.config),
      }),
    ],
  });
});
it("retains local changes on a version conflict and exposes reload", async () => {
  const api = service();
  api.getCourseVmRecommendations.mockResolvedValue({
    templates: [template],
    version: 4,
  });
  api.setCourseVmRecommendations.mockRejectedValue(
    new Error("Recommendations changed; reload"),
  );
  const user = userEvent.setup();
  render(<CourseVmRecommendationsEditor {...course} api={api} />);
  await user.click(
    await screen.findByRole("button", { name: "Remove Notebook CPU" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Save recommendations" }),
  );
  expect(
    await screen.findByText("Recommendations changed; reload"),
  ).toBeVisible();
  expect(api.setCourseVmRecommendations).toHaveBeenCalledWith({
    ...course,
    templates: [],
    expected_version: 4,
  });
  expect(
    screen.getByRole("button", { name: "Reload recommendations" }),
  ).toBeEnabled();
});
