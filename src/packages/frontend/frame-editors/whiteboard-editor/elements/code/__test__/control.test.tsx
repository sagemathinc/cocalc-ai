import { fireEvent, render, screen } from "@testing-library/react";

const useFrameContext = jest.fn();
const getJupyterActions = jest.fn();

jest.mock("../../../hooks", () => ({
  useFrameContext: (...args) => useFrameContext(...args),
}));

jest.mock("../actions", () => ({
  getJupyterActions: (...args) => getJupyterActions(...args),
}));

import ControlBar from "../control";

describe("whiteboard code control bar", () => {
  beforeEach(() => {
    useFrameContext.mockReset();
    getJupyterActions.mockReset();
  });

  it("runs the rooted code tree from the current cell", () => {
    const runCodeTree = jest.fn();
    useFrameContext.mockReturnValue({
      id: "frame-1",
      project_id: "project-1",
      path: "example.board",
      actions: {
        runCodeElement: jest.fn(),
        runCodeTree,
        setElementData: jest.fn(),
      },
    });

    render(
      <ControlBar element={{ id: "cell1", data: {}, type: "code" } as any} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /run tree/i }));
    expect(runCodeTree).toHaveBeenCalledWith("frame-1", "cell1");
  });
});
