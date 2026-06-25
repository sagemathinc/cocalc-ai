import { projectRelativeCoursePath } from "./paths";

describe("course assignment paths", () => {
  it("normalizes runtime HOME absolute paths to project-relative paths", () => {
    expect(projectRelativeCoursePath("/home/user/Assignments/HW1")).toBe(
      "Assignments/HW1",
    );
    expect(projectRelativeCoursePath("/root/Assignments/HW1")).toBe(
      "Assignments/HW1",
    );
  });

  it("leaves existing project-relative paths unchanged", () => {
    expect(projectRelativeCoursePath("Assignments/HW1")).toBe(
      "Assignments/HW1",
    );
  });

  it("preserves non-HOME absolute paths", () => {
    expect(projectRelativeCoursePath("/tmp/data")).toBe("/tmp/data");
  });
});
