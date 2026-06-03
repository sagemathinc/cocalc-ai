/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import ProjectControlStatus from "./project-control-status";

const useTypedReduxMock = jest.fn();
const useProjectMapFieldMock = jest.fn();

jest.mock("antd", () => ({
  Alert: ({ message }: any) => <div>{message}</div>,
  Progress: () => <div>progress</div>,
  Space: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children }: any) => <span>{children}</span>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      setState: jest.fn(),
    }),
  },
  useProjectMapField: (...args: any[]) => useProjectMapFieldMock(...args),
  useTypedRedux: (...args: any[]) => useTypedReduxMock(...args),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    project_id: "11111111-1111-4111-8111-111111111111",
  }),
}));

describe("ProjectControlStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useProjectMapFieldMock.mockReturnValue(undefined);
  });

  it("renders nothing when there is no control status", () => {
    useTypedReduxMock.mockReturnValue(undefined);
    const { container } = render(<ProjectControlStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the current control status", () => {
    useTypedReduxMock.mockReturnValueOnce(
      "Creating final backup before archive...",
    );
    render(<ProjectControlStatus />);
    expect(screen.getByText("Archiving project")).toBeInTheDocument();
    expect(
      screen.getByText("Creating final backup before archive..."),
    ).toBeInTheDocument();
  });

  it("hides stale archive status once the project is archived", () => {
    useTypedReduxMock.mockReturnValueOnce(
      "Creating final backup before archive...",
    );
    useProjectMapFieldMock.mockImplementation(
      (_projectId: string, path: string | string[]) =>
        Array.isArray(path) && path.join(".") === "state.state"
          ? "archived"
          : undefined,
    );
    const { container } = render(<ProjectControlStatus />);
    expect(container).toBeEmptyDOMElement();
  });
});
