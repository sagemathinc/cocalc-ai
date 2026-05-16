/** @jest-environment jsdom */

const confirmMock = jest.fn();
const startProjectMock = jest.fn();
const setSponsorToMeMock = jest.fn();

jest.mock("antd", () => ({
  Modal: {
    confirm: (...args: any[]) => confirmMock(...args),
  },
  Space: ({ children }: any) => <div>{children}</div>,
  Typography: {
    Text: ({ children }: any) => <span>{children}</span>,
  },
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      start_project: (...args: any[]) => startProjectMock(...args),
      set_project_runtime_sponsor_to_me: (...args: any[]) =>
        setSponsorToMeMock(...args),
    }),
  },
}));

describe("showProjectStartRequiredModal", () => {
  beforeEach(() => {
    confirmMock.mockClear();
    startProjectMock.mockClear();
    setSponsorToMeMock.mockClear();
  });

  it("starts manually for autostart-disabled projects", async () => {
    const { showProjectStartRequiredModal } =
      await import("./start-required-modal");

    showProjectStartRequiredModal({
      project_id: "project-1",
      title: "Start project",
      block: {
        code: "autostart_disabled",
        message: "Automatic starts are disabled for this project.",
      },
    });

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ okText: "Start Project" }),
    );
    await confirmMock.mock.calls[0][0].onOk();
    expect(setSponsorToMeMock).not.toHaveBeenCalled();
    expect(startProjectMock).toHaveBeenCalledWith("project-1", {
      autostart: false,
    });
  });

  it("uses the actor as runtime sponsor before starting when sponsor use is blocked", async () => {
    const { showProjectStartRequiredModal } =
      await import("./start-required-modal");

    showProjectStartRequiredModal({
      project_id: "project-1",
      title: "Start project",
      block: {
        code: "collaborator_sponsor_disabled",
        message: "Collaborators cannot start this project.",
      },
    });

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ okText: "Use my membership and start" }),
    );
    await confirmMock.mock.calls[0][0].onOk();
    expect(setSponsorToMeMock).toHaveBeenCalledWith("project-1");
    expect(startProjectMock).toHaveBeenCalledWith("project-1", {
      autostart: false,
    });
  });
});
