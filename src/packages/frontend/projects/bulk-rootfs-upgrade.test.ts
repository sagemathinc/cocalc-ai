import { Map as ImmutableMap } from "immutable";

import {
  buildBulkRootfsUpgradePlan,
  rootfsUpgradeEntryLabel,
} from "./bulk-rootfs-upgrade";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

function image(
  id: string,
  version: string,
  extra: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    image: `cocalc.local/rootfs/minimal:${version}`,
    label: "Minimal",
    family: "minimal",
    version,
    ...extra,
  } as RootfsImageEntry;
}

function project({
  rootfs_image_id,
  state = "opened",
  title = "Project",
}: {
  rootfs_image_id?: string;
  state?: string;
  title?: string;
}) {
  return ImmutableMap({
    title,
    rootfs_image_id,
    state: ImmutableMap({ state }),
  });
}

describe("buildBulkRootfsUpgradePlan", () => {
  it("includes selected projects with newer rootfs entries", () => {
    const rootfsImages = [
      image("minimal-1", "1.0"),
      image("minimal-2", "1.1", { supersedes_image_id: "minimal-1" }),
      image("other", "1.0", { family: "other", label: "Other" }),
    ];
    const projectMap = ImmutableMap({
      "project-1": project({
        title: "Running Project",
        rootfs_image_id: "minimal-1",
        state: "running",
      }),
      "project-2": project({
        title: "Current Project",
        rootfs_image_id: "minimal-2",
      }),
      "project-3": project({ title: "No Image" }),
    });

    const plan = buildBulkRootfsUpgradePlan({
      projectIds: ["project-1", "project-2", "project-3"],
      projectMap,
      rootfsImages,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      project_id: "project-1",
      title: "Running Project",
      restart: true,
    });
    expect(plan[0].next.id).toBe("minimal-2");
  });
});

describe("rootfsUpgradeEntryLabel", () => {
  it("appends the version when the label does not include it", () => {
    expect(rootfsUpgradeEntryLabel(image("minimal-1", "1.0"))).toBe(
      "Minimal 1.0",
    );
  });

  it("does not duplicate versions already present in labels", () => {
    expect(
      rootfsUpgradeEntryLabel(
        image("minimal-1", "1.0", { label: "Minimal 1.0" }),
      ),
    ).toBe("Minimal 1.0");
  });
});
