/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import { ProjectRootfsRuntimeModal } from "./project-rootfs-badge";

const mockEnsureProjectReduxRuntime = jest.fn(async () => undefined);
const mockRuntimeContent = jest.fn(() => (
  <div data-testid="rootfs-runtime-content" />
));

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: () => mockEnsureProjectReduxRuntime(),
}));

jest.mock("./project-rootfs-runtime-modal-content", () => ({
  ProjectRootfsRuntimeModalContent: (props: unknown) =>
    mockRuntimeContent(props),
}));

describe("ProjectRootfsRuntimeModal", () => {
  it("loads project Redux before rendering runtime-dependent content", async () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <ProjectRootfsRuntimeModal
        onClose={onClose}
        open={false}
        project_id=""
      />,
    );

    expect(mockEnsureProjectReduxRuntime).not.toHaveBeenCalled();
    rerender(
      <ProjectRootfsRuntimeModal
        onClose={onClose}
        open
        project_id="project-1"
      />,
    );

    expect(
      await screen.findByTestId("rootfs-runtime-content"),
    ).toBeInTheDocument();
    expect(mockEnsureProjectReduxRuntime).toHaveBeenCalledTimes(1);
    expect(mockRuntimeContent).toHaveBeenCalledWith({
      onClose,
      open: true,
      project_id: "project-1",
    });
  });
});
