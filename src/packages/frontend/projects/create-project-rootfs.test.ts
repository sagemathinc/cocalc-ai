import {
  chooseAutomaticProjectRootfs,
  chooseDefaultProjectImage,
  describeProjectImageReason,
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

  const managed = (id: string, opts: Partial<RootfsImageEntry> = {}) =>
    image(id, `cocalc.local/rootfs/${id}`, {
      official: true,
      release_id: `release-${id}`,
      ...opts,
    });
  const catalog = [
    managed("python"),
    managed("r"),
    managed("sage"),
    managed("hidden", { hidden: true }),
  ];

  it("chooses nothing when there are several images and no signal", () => {
    expect(chooseDefaultProjectImage({ images: catalog, isGpu: false })).toBe(
      undefined,
    );
  });

  it("uses your own default image first", () => {
    const chosen = chooseDefaultProjectImage({
      images: catalog,
      isGpu: false,
      accountDefault: "cocalc.local/rootfs/r",
      recent: [{ project_id: "p1", title: "Thesis", image_id: "sage" }],
    });
    expect(chosen?.entry.id).toBe("r");
    expect(chosen?.reason).toEqual({ kind: "account" });
  });

  it("then the image of the project you used most recently, at its newest version", () => {
    const sageNew = managed("sage-2", { supersedes_image_id: "sage" });
    const chosen = chooseDefaultProjectImage({
      images: [...catalog, sageNew],
      isGpu: false,
      recent: [
        // Its image is gone (hidden); the next project's counts.
        { project_id: "p0", title: "Old", image_id: "hidden" },
        { project_id: "p1", title: "Thesis", image_id: "sage" },
        { project_id: "p2", title: "Stats", image_id: "r" },
      ],
      latestVersion: (entry) => (entry.id === "sage" ? sageNew : entry),
    });
    expect(chosen?.entry.id).toBe("sage-2");
    expect(chosen?.reason).toEqual({
      kind: "recent",
      project_id: "p1",
      title: "Thesis",
    });
    expect(describeProjectImageReason(chosen?.reason)).toBe(
      'as in your project "Thesis"',
    );
  });

  it("then the image a site admin tagged as the default for new projects", () => {
    const chosen = chooseDefaultProjectImage({
      images: [
        ...catalog,
        managed("community", {
          official: false,
          tags: ["onboarding:default"],
        }),
        managed("standard", { tags: ["onboarding:default"] }),
      ],
      isGpu: false,
    });
    expect(chosen?.entry.id).toBe("standard");
    expect(chosen?.reason).toEqual({ kind: "site" });
  });

  it("uses the only image there is", () => {
    const chosen = chooseDefaultProjectImage({
      images: [managed("python"), managed("hidden", { hidden: true })],
      isGpu: false,
    });
    expect(chosen?.entry.id).toBe("python");
    expect(chosen?.reason).toEqual({ kind: "only" });
  });

  it("never picks a raw OCI image for ordinary users, or over managed images for admins", () => {
    const oci = image("base", "buildpack-deps:noble-scm", { official: true });
    expect(
      chooseDefaultProjectImage({
        images: [oci],
        isGpu: false,
        accountDefault: "buildpack-deps:noble-scm",
      }),
    ).toBe(undefined);
    expect(
      chooseDefaultProjectImage({
        images: [oci, managed("python")],
        isGpu: false,
        isAdmin: true,
        accountDefault: "buildpack-deps:noble-scm",
      })?.entry.id,
    ).toBe("python");
    // With no managed images, an admin's only choice is the OCI image.
    expect(
      chooseDefaultProjectImage({ images: [oci], isGpu: false, isAdmin: true })
        ?.entry.id,
    ).toBe("base");
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
