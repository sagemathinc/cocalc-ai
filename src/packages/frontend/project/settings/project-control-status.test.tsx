/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import ProjectControlStatus from "./project-control-status";

const useTypedReduxMock = jest.fn();

jest.mock("antd", () => ({
  Alert: ({ message }: any) => <div>{message}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      setState: jest.fn(),
    }),
  },
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
  });

  it("renders nothing when there is no control status", () => {
    useTypedReduxMock.mockReturnValue(undefined);
    const { container } = render(<ProjectControlStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the current control status", () => {
    useTypedReduxMock
      .mockReturnValueOnce("Creating final backup before archive...")
      .mockReturnValueOnce(undefined);
    render(<ProjectControlStatus />);
    expect(
      screen.getByText("Creating final backup before archive..."),
    ).toBeInTheDocument();
  });

  it("hides stale archive status once the project is archived", () => {
    useTypedReduxMock
      .mockReturnValueOnce("Creating final backup before archive...")
      .mockReturnValueOnce({
        getIn: (path: string[]) =>
          path.join(".") === "11111111-1111-4111-8111-111111111111.state.state"
            ? "archived"
            : undefined,
      });
    const { container } = render(<ProjectControlStatus />);
    expect(container).toBeEmptyDOMElement();
  });
});
