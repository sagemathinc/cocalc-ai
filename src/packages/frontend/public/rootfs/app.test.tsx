/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

import { useRootfsImages } from "@cocalc/frontend/rootfs/manifest";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import PublicRootfsApp from "./app";

jest.mock("@cocalc/frontend/rootfs/manifest", () => ({
  managedRootfsCatalogUrl: () => "/rootfs/catalog.json",
  useRootfsImages: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

function image(
  version: string,
  opts: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id: `minimal-${version}`,
    slug: `minimal-${version.replace(".", "-")}`,
    image: `cocalc.local/rootfs/minimal-${version}`,
    label: "Minimal Jupyter and LaTeX",
    description: "A compact scientific computing environment.",
    family: "minimal-jupyter-latex",
    version,
    channel: "stable",
    official: true,
    arch: ["amd64"],
    ...opts,
  };
}

describe("public RootFS catalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("features the latest image and reveals direct links to previous versions", () => {
    const v10 = image("1.0");
    const v15 = image("1.5", { supersedes_image_id: v10.id });
    const v20 = image("2.0", { supersedes_image_id: v15.id });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [v10, v20, v15],
      loading: false,
    });

    const { container } = render(
      <PublicRootfsApp
        config={{ site_name: "CoCalc" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByText(
        "Discover project runtime images that include ready-to-use software, examples, and files. Choose an image to create a matching project.",
      ),
    ).toHaveStyle({ width: "100%" });
    expect(screen.getByText("Latest")).not.toBeNull();
    expect(
      container.querySelector(
        ".ant-card.cocalc-public-interactive-card.ant-card-hoverable",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Version 2.0")).not.toBeNull();
    expect(screen.queryByText("Version 1.5")).toBeNull();

    const versions = screen.getByRole("button", {
      name: /View 2 previous versions/i,
    });
    expect(versions).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(versions);

    expect(versions).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Version 1.5/i })).toHaveAttribute(
      "href",
      "/rootfs/minimal-1-5",
    );
    expect(screen.getByRole("link", { name: /Version 1.0/i })).toHaveAttribute(
      "href",
      "/rootfs/minimal-1-0",
    );
  });

  it("uses singular copy for one previous version", () => {
    const v10 = image("1.0");
    const v20 = image("2.0", { supersedes_image_id: v10.id });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [v10, v20],
      loading: false,
    });

    render(<PublicRootfsApp initialRoute={{ view: "index" }} />);

    expect(
      screen.getByRole("button", { name: "View 1 previous version" }),
    ).not.toBeNull();
  });

  it("filters image families from the shared and card-level tag pills", () => {
    const sage = image("10.9", {
      id: "sage",
      slug: "sage",
      family: "sagemath",
      label: "SageMath",
      tags: ["python", "math", "source:/rootfs/catalog.json"],
    });
    const r = image("4.5", {
      id: "r",
      slug: "r",
      family: "r",
      label: "R and RStudio",
      tags: ["r", "statistics"],
    });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [sage, r],
      loading: false,
    });

    render(<PublicRootfsApp initialRoute={{ view: "index" }} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Filter by #python (1 family)" }),
    );
    expect(screen.getByText("Filtered by #python")).not.toBeNull();
    expect(screen.getByText("SageMath")).not.toBeNull();
    expect(screen.queryByText("R and RStudio")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const rTags = screen.getByRole("group", { name: "Tags for R and RStudio" });
    fireEvent.click(
      within(rTags).getByRole("button", { name: "Filter by #statistics" }),
    );
    expect(screen.getByText("Filtered by #statistics")).not.toBeNull();
    expect(screen.queryByText("SageMath")).toBeNull();
    expect(screen.getByText("R and RStudio")).not.toBeNull();
  });

  it("combines selected tags and keeps impossible tags visible but disabled", () => {
    const sage = image("10.9", {
      id: "sage",
      family: "sagemath",
      label: "SageMath",
      tags: ["python", "math"],
    });
    const python = image("3.14", {
      id: "python",
      family: "python",
      label: "Python",
      tags: ["python", "data-science"],
    });
    const r = image("4.5", {
      id: "r",
      family: "r",
      label: "R and RStudio",
      tags: ["r", "statistics"],
    });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [sage, python, r],
      loading: false,
    });

    render(<PublicRootfsApp initialRoute={{ view: "index" }} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Filter by #python (2 families)" }),
    );
    expect(screen.getByText("SageMath")).not.toBeNull();
    expect(screen.getByText("Python")).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Filter by #statistics (1 family)",
      }),
    ).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Filter by #math (1 family)" }),
    );
    expect(screen.getByText("Filtered by #python + #math")).not.toBeNull();
    expect(screen.getByText("SageMath")).not.toBeNull();
    expect(screen.queryByText("Python")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Filter by #data-science (1 family)",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Filter by #python (2 families)" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("filters a family by tags carried only by an older release", () => {
    const previous = image("1.0", { tags: ["gpu"] });
    const latest = image("2.0", { tags: [] });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [previous, latest],
      loading: false,
    });

    render(<PublicRootfsApp initialRoute={{ view: "index" }} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Filter by #gpu (1 family)" }),
    );
    expect(screen.getByText("Minimal Jupyter and LaTeX")).not.toBeNull();
    expect(screen.getByText("Filtered by #gpu")).not.toBeNull();
  });

  it("warns on an older detail page and links to the latest release", () => {
    const previous = image("3.13", {
      id: "python-313",
      label: "Python 3.13",
      slug: "python-3-13",
      family: "python",
    });
    const latest = image("3.14", {
      id: "python-314",
      label: "Python 3.14",
      slug: "python-3-14",
      family: "python",
      supersedes_image_id: previous.id,
    });
    jest.mocked(useRootfsImages).mockReturnValue({
      error: undefined,
      images: [previous, latest],
      loading: false,
    });

    render(
      <PublicRootfsApp initialRoute={{ slug: "python-3-13", view: "slug" }} />,
    );

    expect(
      screen.getByText("A newer version of this image is available"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "View latest version" }),
    ).toHaveAttribute("href", "/rootfs/python-3-14");
    expect(useRootfsImages).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allPages: true }),
    );
    expect(useRootfsImages).toHaveBeenCalledWith(
      ["/rootfs/catalog.json"],
      expect.objectContaining({ lineageImageId: previous.id }),
    );
  });
});
