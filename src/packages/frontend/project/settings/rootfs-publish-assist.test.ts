/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import {
  defaultRootfsSupersedesImageId,
  rootfsSupersedesOptions,
} from "./rootfs-publish-assist";

function image(id: string, label: string, version?: string): RootfsImageEntry {
  return {
    id,
    image: `cocalc.local/rootfs/${id}`,
    label,
    version,
    visibility: "public",
  };
}

describe("rootfsSupersedesOptions", () => {
  const source = image("r-p1", "R", "4.5.2.p1");
  const other = image("basic", "CoCalc Basic", "1.7");

  it("includes the source image when publishing a new release", () => {
    expect(
      rootfsSupersedesOptions({
        images: [source, other],
        publishMode: "copy",
        publishSourceEntryId: source.id,
      }),
    ).toContainEqual({ value: source.id, label: "R (4.5.2.p1)" });
  });

  it("excludes the source image when managing its catalog entry", () => {
    expect(
      rootfsSupersedesOptions({
        images: [source, other],
        publishMode: "manage",
        publishSourceEntryId: source.id,
      }),
    ).toEqual([{ value: other.id, label: "CoCalc Basic (1.7)" }]);
  });
});

describe("defaultRootfsSupersedesImageId", () => {
  it("does not supersede an image the user cannot manage", () => {
    expect(
      defaultRootfsSupersedesImageId({
        entry: image("official", "CoCalc Legacy"),
        publishMode: "copy",
      }),
    ).toBe("");
  });

  it("supersedes the source when copying an image the user can manage", () => {
    expect(
      defaultRootfsSupersedesImageId({
        entry: { ...image("custom", "Course Image"), can_manage: true },
        publishMode: "copy",
      }),
    ).toBe("custom");
  });

  it("preserves the predecessor when managing an image", () => {
    expect(
      defaultRootfsSupersedesImageId({
        entry: {
          ...image("custom-v2", "Course Image"),
          supersedes_image_id: "custom-v1",
        },
        publishMode: "manage",
      }),
    ).toBe("custom-v1");
  });
});
