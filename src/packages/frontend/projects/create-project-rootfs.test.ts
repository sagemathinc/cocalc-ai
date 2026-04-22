import {
  chooseNewProjectRootfsDefault,
  isNewProjectRootfsSelectable,
} from "./create-project-rootfs";

import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

function image(
  id: string,
  image: string,
  opts: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    image,
    label: id,
    ...opts,
  };
}

describe("new project RootFS selection", () => {
  it("excludes hidden images from the user-facing picker", () => {
    expect(
      isNewProjectRootfsSelectable({
        entry: image("hidden", "buildpack-deps:noble-scm", { hidden: true }),
        isGpu: false,
      }),
    ).toBe(false);
  });

  it("excludes GPU images for non-GPU projects", () => {
    expect(
      isNewProjectRootfsSelectable({
        entry: image("gpu", "cocalc.local/rootfs/gpu", {
          gpu: true,
          release_id: "release-gpu",
        }),
        isGpu: false,
      }),
    ).toBe(false);
  });

  it("prefers a managed image over a configured OCI default", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [
        image("base", "buildpack-deps:noble-scm", { official: true }),
        image("managed", "cocalc.local/rootfs/snapshot", {
          official: true,
          release_id: "release-1",
        }),
      ],
      isGpu: false,
      preferredImages: ["buildpack-deps:noble-scm"],
      fallbackImage: "buildpack-deps:noble-scm",
    });

    expect(selected?.id).toBe("managed");
  });

  it("does not select a hidden configured default", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [
        image("hidden-base", "buildpack-deps:noble-scm", {
          hidden: true,
          official: true,
        }),
        image("managed", "cocalc.local/rootfs/snapshot", {
          official: true,
          release_id: "release-1",
        }),
      ],
      isGpu: false,
      preferredImages: ["buildpack-deps:noble-scm"],
      fallbackImage: "buildpack-deps:noble-scm",
    });

    expect(selected?.id).toBe("managed");
  });

  it("falls back to OCI only when no managed image is available", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [image("base", "buildpack-deps:noble-scm", { official: true })],
      isGpu: false,
      preferredImages: ["buildpack-deps:noble-scm"],
      fallbackImage: "buildpack-deps:noble-scm",
    });

    expect(selected?.id).toBe("base");
  });
});
