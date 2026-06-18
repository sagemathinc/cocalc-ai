/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { ProjectRootfsBadge } from "./project-rootfs-badge";

jest.mock("antd", () => ({
  Tag: ({ children }: any) => <span>{children}</span>,
  Typography: {
    Text: ({ children }: any) => <span>{children}</span>,
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
  isIconName: (name: any) => typeof name === "string" && name.length > 0,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/project/settings/root-filesystem-image", () => ({
  RootFilesystemImageModal: () => null,
}));

jest.mock("@cocalc/frontend/rootfs/catalog-ui", () => ({
  latestRootfsUpgradeEntry: () => undefined,
}));

describe("ProjectRootfsBadge", () => {
  it("does not render the default Empty Project label", () => {
    const { container } = render(
      <ProjectRootfsBadge
        rootfsImageId="empty-project"
        rootfsImages={[
          {
            id: "empty-project",
            label: "Empty Project",
            image: "cocalc.local/rootfs/empty-project",
          },
        ]}
      />,
    );

    expect(screen.queryByText("Empty Project")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders non-empty project rootfs labels", () => {
    render(
      <ProjectRootfsBadge
        rootfsImageId="python"
        rootfsImages={[
          {
            id: "python",
            label: "Python",
            image: "cocalc.local/rootfs/python",
          },
        ]}
      />,
    );

    expect(screen.getByText("Python")).not.toBeNull();
  });
});
