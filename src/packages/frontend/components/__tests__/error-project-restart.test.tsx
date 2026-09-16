import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ShowError, { PROJECT_RUNTIME_UPGRADE_ERROR_SIGNATURE } from "../error";
import { ProjectErrorActionsProvider } from "../project-error-actions";

describe("ShowError project runtime restart action", () => {
  it("offers to restart for upgrade errors displayed inside a project", async () => {
    const restartProject = jest.fn(async () => {});
    const setError = jest.fn();
    render(
      <ProjectErrorActionsProvider
        projectId="project-1"
        restartProject={restartProject}
      >
        <ShowError
          noMarkdown
          error={`CoCalc was upgraded. ${PROJECT_RUNTIME_UPGRADE_ERROR_SIGNATURE}`}
          setError={setError}
        />
      </ProjectErrorActionsProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(restartProject).toHaveBeenCalledTimes(1));
    expect(setError).toHaveBeenCalledWith("");
  });

  it("does not offer restart for unrelated project errors", () => {
    render(
      <ProjectErrorActionsProvider
        projectId="project-1"
        restartProject={jest.fn()}
      >
        <ShowError noMarkdown error="An unrelated error" />
      </ProjectErrorActionsProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Restart Project" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer restart outside a project", () => {
    render(
      <ShowError
        noMarkdown
        error={`CoCalc was upgraded. ${PROJECT_RUNTIME_UPGRADE_ERROR_SIGNATURE}`}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Restart Project" }),
    ).not.toBeInTheDocument();
  });
});
