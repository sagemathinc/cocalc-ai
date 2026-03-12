import { CSILauncher } from "./custom-image";

jest.mock("../custom-software/util", () => ({
  NAME: "custom-software",
  custom_image_name: (imageId: string) => `custom:${imageId}`,
}));

describe("CSILauncher", () => {
  it("opens newly created projects at project-home", async () => {
    const launcher = new CSILauncher("course-calculate-20") as any;
    const open_project = jest.fn();
    launcher.actions = {
      create_project: jest.fn().mockResolvedValue("project-1"),
      open_project,
    };
    launcher.custom_software_table = {
      _table: {
        get: jest.fn(() => ({
          get: jest.fn((key: string) =>
            key === "display" ? "Course Calculate 20" : undefined,
          ),
        })),
      },
    };

    await launcher.create_project();

    expect(launcher.actions.create_project).toHaveBeenCalledWith({
      title: "Course Calculate 20",
      image: "custom:course-calculate-20",
    });
    expect(open_project).toHaveBeenCalledWith({
      project_id: "project-1",
      target: "project-home",
      switch_to: true,
    });
  });
});
