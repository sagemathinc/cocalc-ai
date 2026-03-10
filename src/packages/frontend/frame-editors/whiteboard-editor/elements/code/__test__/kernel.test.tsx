import { render, screen, waitFor } from "@testing-library/react";

const useFrameContext = jest.fn();
const getJupyterFrameEditorActions = jest.fn();
const kernelMock = jest.fn(({ compact }) => (
  <div data-compact={compact ? "yes" : "no"}>kernel status</div>
));

jest.mock("../../../hooks", () => ({
  useFrameContext: (...args) => useFrameContext(...args),
}));

jest.mock("../actions", () => ({
  getJupyterFrameEditorActions: (...args) =>
    getJupyterFrameEditorActions(...args),
  openJupyterNotebook: jest.fn(),
}));

jest.mock("@cocalc/frontend/app-framework/is-mounted-hook", () => () => ({
  current: true,
}));

jest.mock("@cocalc/frontend/jupyter/status", () => ({
  Kernel: (props) => kernelMock(props),
}));

import KernelPanel from "../kernel";

describe("whiteboard kernel panel", () => {
  beforeEach(() => {
    useFrameContext.mockReset();
    getJupyterFrameEditorActions.mockReset();
    kernelMock.mockClear();
  });

  it("uses the shared compact kernel header without rendering a second selector", async () => {
    useFrameContext.mockReturnValue({
      project_id: "project-1",
      path: "example.board",
      id: "frame-1",
      desc: {
        get: (key: string) => (key === "selectedTool" ? "code" : undefined),
      },
      actions: {
        selectionContainsCellOfType: jest.fn().mockReturnValue(false),
      },
    });
    getJupyterFrameEditorActions.mockResolvedValue({
      jupyter_actions: {
        name: "jupyter-test",
        store: { get: jest.fn().mockReturnValue("ready") },
      },
    });

    render(<KernelPanel />);

    await waitFor(() => expect(screen.getByText("kernel status")).toBeTruthy());
    expect(kernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ compact: true }),
    );
    expect(screen.queryByText(/kernel selector/i)).toBeNull();
  });
});
