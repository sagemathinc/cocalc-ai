import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

import { latestRootfsUpgradeEntry } from "./catalog-ui";

function image(
  id: string,
  version: string,
  opts: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    label: "Minimal Image - Jupyter and Latex",
    image: `cocalc.local/rootfs/${id}`,
    family: "minimal-jupyter-latex",
    version,
    channel: "stable",
    ...opts,
  };
}

describe("rootfs catalog upgrade suggestions", () => {
  it("follows an explicit supersedes chain to the latest image", () => {
    const v11 = image("v1.1", "1.1");
    const v12 = image("v1.2", "1.2", {
      supersedes_image_id: "v1.1",
    });
    const v13 = image("v1.3", "1.3", {
      supersedes_image_id: "v1.2",
    });

    expect(
      latestRootfsUpgradeEntry({
        current: v11,
        images: [v12, v13],
      })?.id,
    ).toBe("v1.3");
  });

  it("uses the max reachable version if a supersedes chain loops", () => {
    const v12 = image("v1.2", "1.2", {
      supersedes_image_id: "v1.3",
    });
    const v13 = image("v1.3", "1.3", {
      supersedes_image_id: "v1.2",
    });

    expect(
      latestRootfsUpgradeEntry({
        current: v12,
        images: [v13],
      })?.id,
    ).toBe("v1.3");
  });

  it("falls back to the newest related version when no explicit chain exists", () => {
    const v11 = image("v1.1", "1.1");
    const v12 = image("v1.2", "1.2");
    const v13 = image("v1.3", "1.3");

    expect(
      latestRootfsUpgradeEntry({
        current: v11,
        images: [v12, v13],
      })?.id,
    ).toBe("v1.3");
  });

  it("prefers the newest related version over an older immediate supersedes target", () => {
    const v11 = image("v1.1", "1.1");
    const v12 = image("v1.2", "1.2", {
      supersedes_image_id: "v1.1",
    });
    const v13 = image("v1.3", "1.3");

    expect(
      latestRootfsUpgradeEntry({
        current: v11,
        images: [v12, v13],
      })?.id,
    ).toBe("v1.3");
  });
});
