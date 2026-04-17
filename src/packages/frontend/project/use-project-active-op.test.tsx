import { render } from "@testing-library/react";
import { useProjectActiveOperation } from "./use-project-active-op";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getProjectActiveOperation: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("./use-project-field", () => ({
  createProjectFieldState: jest.fn(() => ({ field: "active_op" })),
  getCachedProjectFieldValue: jest.fn(),
  useProjectField: jest.fn(),
}));

const { webapp_client } = jest.requireMock("@cocalc/frontend/webapp-client") as {
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getProjectActiveOperation: jest.Mock;
        };
      };
    };
  };
};

const {
  useProjectField,
  getCachedProjectFieldValue,
} = jest.requireMock("./use-project-field") as {
  useProjectField: jest.Mock;
  getCachedProjectFieldValue: jest.Mock;
};

const getProjectActiveOperation =
  webapp_client.conat_client.hub.projects.getProjectActiveOperation;

function TestComponent() {
  useProjectActiveOperation("project-1");
  return null;
}

describe("useProjectActiveOperation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useProjectField.mockReturnValue({
      value: null,
      refresh: jest.fn(),
      setValue: jest.fn(),
    });
  });

  it("keeps the cached active operation when the hub call fails", async () => {
    getProjectActiveOperation.mockRejectedValue(
      new Error("hub timeout during reconnect"),
    );
    getCachedProjectFieldValue.mockReturnValue({
      kind: "project-start",
      status: "running",
    });

    render(<TestComponent />);

    const [{ fetch }] = useProjectField.mock.calls[0];
    await expect(fetch("project-1")).resolves.toEqual({
      kind: "project-start",
      status: "running",
    });
  });

  it("returns null when there is no cached active operation", async () => {
    getProjectActiveOperation.mockRejectedValue(new Error("hub timeout"));
    getCachedProjectFieldValue.mockReturnValue(undefined);

    render(<TestComponent />);

    const [{ fetch }] = useProjectField.mock.calls[0];
    await expect(fetch("project-1")).resolves.toBeNull();
  });
});
