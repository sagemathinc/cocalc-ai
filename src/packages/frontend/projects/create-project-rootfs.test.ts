import {
  chooseAutomaticProjectRootfs,
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

describe("new project image selection", () => {
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

  it("does not offer OCI fallback to ordinary users", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [image("base", "buildpack-deps:noble-scm", { official: true })],
      isGpu: false,
      preferredImages: ["buildpack-deps:noble-scm"],
      fallbackImage: "buildpack-deps:noble-scm",
    });

    expect(selected).toBeUndefined();
  });

  it("does not choose a default when multiple managed images are available", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [
        image("standard", "cocalc.local/rootfs/standard", {
          official: true,
          release_id: "release-standard",
        }),
        image("sage", "cocalc.local/rootfs/sage", {
          official: true,
          release_id: "release-sage",
        }),
      ],
      isGpu: false,
      preferredImages: ["cocalc.local/rootfs/standard"],
      fallbackImage: "cocalc.local/rootfs/standard",
    });

    expect(selected).toBeUndefined();
  });

  it("allows admins to fall back to OCI when no managed image is available", () => {
    const selected = chooseNewProjectRootfsDefault({
      images: [image("base", "buildpack-deps:noble-scm", { official: true })],
      isGpu: false,
      isAdmin: true,
      preferredImages: ["buildpack-deps:noble-scm"],
      fallbackImage: "buildpack-deps:noble-scm",
    });

    expect(selected?.id).toBe("base");
  });

  it("chooses an official managed CPU image when no onboarding tags are configured", () => {
    const selected = chooseAutomaticProjectRootfs({
      images: [
        image("legacy", "buildpack-deps:noble-scm", { official: true }),
        image("gpu", "cocalc.local/rootfs/gpu", {
          official: true,
          gpu: true,
          release_id: "release-gpu",
        }),
        image("community", "cocalc.local/rootfs/community", {
          release_id: "release-community",
          tags: ["standard"],
        }),
        image("official", "cocalc.local/rootfs/standard", {
          official: true,
          release_id: "release-standard",
          label: "standard",
          created: "2026-04-01T00:00:00Z",
        }),
        image("code-server", "cocalc.local/rootfs/code-server", {
          official: true,
          release_id: "release-code-server",
          created: "2026-05-01T00:00:00Z",
        }),
      ],
    });

    expect(selected?.id).toBe("official");
  });

  it("honors a selectable configured default but not hidden or legacy defaults", () => {
    const images = [
      image("hidden", "cocalc.local/rootfs/hidden", {
        hidden: true,
        release_id: "release-hidden",
      }),
      image("preferred", "cocalc.local/rootfs/preferred", {
        release_id: "release-preferred",
      }),
      image("official", "cocalc.local/rootfs/official", {
        official: true,
        release_id: "release-official",
      }),
    ];
    expect(
      chooseAutomaticProjectRootfs({
        images,
        preferredImages: ["cocalc.local/rootfs/preferred"],
      })?.id,
    ).toBe("preferred");
    expect(
      chooseAutomaticProjectRootfs({
        images,
        preferredImages: [
          "buildpack-deps:noble-scm",
          "cocalc.local/rootfs/hidden",
        ],
      })?.id,
    ).toBe("official");
  });

  it("does not create an unusable legacy project when the catalog has no selectable image", () => {
    expect(
      chooseAutomaticProjectRootfs({
        images: [image("legacy", "buildpack-deps:noble-scm")],
      }),
    ).toBeUndefined();
  });
});
