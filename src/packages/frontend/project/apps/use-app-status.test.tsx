import { render, screen, waitFor } from "@testing-library/react";
import { useAppStatus } from "./use-app-status";
import { webapp_client } from "@cocalc/frontend/webapp-client";

let currentProjectId = "project-1";

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: currentProjectId }),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectApi: jest.fn(),
    },
  },
}));

jest.mock("react-interval-hook", () => ({
  useInterval: jest.fn(),
}));

function TestComponent() {
  const { status, loading } = useAppStatus({ name: "app-1" });
  return (
    <div>
      <span data-testid="status">{status?.state ?? ""}</span>
      <span data-testid="loading">{loading ? "yes" : "no"}</span>
    </div>
  );
}

describe("useAppStatus", () => {
  const projectApiMock = webapp_client.conat_client.projectApi as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    currentProjectId = "project-1";
  });

  it("refetches and clears stale status when the project changes", async () => {
    projectApiMock.mockImplementation(({ project_id }) => ({
      apps: {
        status: jest.fn(async () =>
          project_id === "project-1"
            ? { state: "running" }
            : { state: "stopped" },
        ),
        waitForState: jest.fn(async () => true),
      },
    }));

    const { rerender } = render(<TestComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("running");
    });

    currentProjectId = "project-2";
    rerender(<TestComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("stopped");
    });
    expect(projectApiMock.mock.calls).toEqual(
      expect.arrayContaining([
        [{ project_id: "project-1" }],
        [{ project_id: "project-2" }],
      ]),
    );
  });
});
