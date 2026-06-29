import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { R2Region } from "@cocalc/util/consts";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import {
  applyProjectPreset,
  createInitialProjectDraft,
  projectDraftSummary,
  projectDraftToCreateOptions,
  setProjectDraftHost,
  setProjectDraftRegion,
  setProjectDraftRootfs,
  setProjectDraftStart,
  setProjectDraftTitle,
  type ProjectCreateContext,
} from "./project-create-draft";

function image(
  id: string,
  runtimeImage: string,
  opts: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    image: runtimeImage,
    label: id,
    ...opts,
  };
}

function host(opts: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    name: "Host 1",
    owner: "account-1",
    region: "us-west1",
    size: "small",
    gpu: false,
    status: "running",
    ...opts,
  };
}

function context(
  opts: Partial<ProjectCreateContext> = {},
): ProjectCreateContext {
  return {
    defaultTitle: "Untitled 2026-05-20",
    preferredRegion: "wnam",
    rootfsImages: [
      image("standard", "cocalc.local/rootfs/standard", {
        official: true,
        release_id: "release-standard",
      }),
      image("sage", "cocalc.local/rootfs/sage", {
        official: true,
        release_id: "release-sage",
      }),
      image("gpu", "cocalc.local/rootfs/gpu", {
        official: true,
        gpu: true,
        release_id: "release-gpu",
      }),
      image("hidden", "cocalc.local/rootfs/hidden", {
        hidden: true,
        official: true,
        release_id: "release-hidden",
      }),
    ],
    siteDefaultRootfs: "cocalc.local/rootfs/standard",
    siteDefaultRootfsGpu: "cocalc.local/rootfs/gpu",
    ...opts,
  };
}

describe("project create draft", () => {
  it("creates a standard draft that requires an explicit image choice", () => {
    const draft = createInitialProjectDraft(context());

    expect(draft).toEqual(
      expect.objectContaining({
        title: "Untitled 2026-05-20",
        mode: "standard",
        region: "wnam",
        start: true,
        rootfs_image: "",
        rootfs_image_id: undefined,
      }),
    );
  });

  it("allows the initial draft to require a user-entered title", () => {
    const ctx = context({ defaultTitle: "" });
    const draft = createInitialProjectDraft(ctx);

    expect(draft.title).toBe("");
    expect(projectDraftSummary(draft, ctx).warnings).toContain(
      "Project title is required.",
    );
  });

  it("auto-selects an image only when there is one usable option", () => {
    const draft = createInitialProjectDraft(
      context({
        rootfsImages: [
          image("standard", "cocalc.local/rootfs/standard", {
            official: true,
            release_id: "release-standard",
          }),
        ],
      }),
    );

    expect(draft.rootfs_image).toBe("cocalc.local/rootfs/standard");
    expect(draft.rootfs_image_id).toBe("standard");
  });

  it("requires an explicit image choice when a GPU host is selected", () => {
    const ctx = context();
    const selectedHost = host({
      id: "gpu-host",
      name: "GPU host",
      gpu: true,
    });
    let draft = createInitialProjectDraft(ctx);

    draft = setProjectDraftHost(draft, selectedHost, ctx);

    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
    expect(projectDraftSummary(draft, context({ selectedHost })).gpu).toBe(
      true,
    );
  });

  it("preserves a user-touched image when the host changes", () => {
    const custom = image("custom", "cocalc.local/rootfs/custom", {
      release_id: "release-custom",
    });
    const ctx = context({ rootfsImages: [...context().rootfsImages, custom] });
    let draft = createInitialProjectDraft(ctx);
    draft = setProjectDraftRootfs(
      draft,
      { image: custom.image, image_id: custom.id },
      ctx,
    );

    draft = setProjectDraftHost(
      draft,
      host({ id: "gpu-host", name: "GPU host", gpu: true }),
      ctx,
    );

    expect(draft.rootfs_image).toBe(custom.image);
    expect(draft.rootfs_image_id).toBe(custom.id);
  });

  it("clears an explicitly selected host when region changes away from host region", () => {
    const selectedHost = host({
      id: "east-host",
      name: "East host",
      region: "us-east1",
    });
    const ctx = context({ preferredRegion: "enam", selectedHost });
    let draft = createInitialProjectDraft(ctx);
    draft = setProjectDraftHost(draft, selectedHost, ctx);

    expect(draft.host_id).toBe("east-host");

    draft = setProjectDraftRegion(draft, "wnam", {
      ...ctx,
      selectedHost,
    });

    expect(draft.host_id).toBeUndefined();
  });

  it("updates the backup region when selecting a host in another region", () => {
    const selectedHost = host({
      id: "europe-host",
      name: "Europe host",
      region: "eu-north1",
    });
    const ctx = context({ preferredRegion: "wnam" });
    const draft = setProjectDraftHost(
      createInitialProjectDraft(ctx),
      selectedHost,
      ctx,
    );

    expect(draft.host_id).toBe("europe-host");
    expect(draft.region).toBe("weur");
    expect(projectDraftToCreateOptions(draft)).toEqual(
      expect.objectContaining({
        host_id: "europe-host",
        region: "weur",
      }),
    );
  });

  it("maps create without open to start false", () => {
    const draft = setProjectDraftStart(
      createInitialProjectDraft(context()),
      false,
    );

    expect(projectDraftToCreateOptions(draft)).toEqual(
      expect.objectContaining({
        title: "Untitled 2026-05-20",
        start: false,
        region: "wnam",
      }),
    );
    expect(projectDraftToCreateOptions(draft).rootfs_image).toBeUndefined();
  });

  it("maps create and open to start true", () => {
    const draft = setProjectDraftStart(
      createInitialProjectDraft(context()),
      true,
    );

    expect(projectDraftToCreateOptions(draft).start).toBe(true);
  });

  it("does not recalculate image when only the title changes", () => {
    const ctx = context({ isAdmin: true });
    const draft = setProjectDraftRootfs(
      createInitialProjectDraft(ctx),
      { image: "docker.io/library/ubuntu:24.04" },
      ctx,
    );

    const renamed = setProjectDraftTitle(draft, "A better name");

    expect(renamed.title).toBe("A better name");
    expect(renamed.rootfs_image).toBe("docker.io/library/ubuntu:24.04");
    expect(renamed.rootfs_image_id).toBeUndefined();
  });

  it("applies the GPU preset without silently choosing an image", () => {
    const draft = applyProjectPreset(
      createInitialProjectDraft(context()),
      "gpu",
      context(),
    );

    expect(draft.mode).toBe("gpu");
    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("does not silently choose a teaching-tagged image when other images exist", () => {
    const teaching = image("teaching", "cocalc.local/rootfs/teaching", {
      official: true,
      priority: 10,
      release_id: "release-teaching",
      tags: ["teaching"],
    });
    const ctx = context({
      rootfsImages: [...context().rootfsImages, teaching],
    });
    const draft = applyProjectPreset(
      createInitialProjectDraft(ctx),
      "teaching",
      ctx,
    );

    expect(draft.mode).toBe("teaching");
    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("does not silently choose among multiple GPU images", () => {
    const genericGpu = image("generic-gpu", "cocalc.local/rootfs/generic-gpu", {
      official: true,
      gpu: true,
      priority: 1000,
      release_id: "release-generic-gpu",
      tags: ["gpu"],
    });
    const presetGpu = image("preset-gpu", "cocalc.local/rootfs/preset-gpu", {
      gpu: true,
      release_id: "release-preset-gpu",
      tags: ["preset:gpu"],
    });
    const ctx = context({
      rootfsImages: [context().rootfsImages[0], genericGpu, presetGpu],
      siteDefaultRootfsGpu: undefined,
    });

    const draft = applyProjectPreset(
      createInitialProjectDraft(ctx),
      "gpu",
      ctx,
    );

    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("does not select hidden preset-tagged image entries", () => {
    const hiddenTeaching = image(
      "hidden-teaching",
      "cocalc.local/rootfs/hidden-teaching",
      {
        hidden: true,
        official: true,
        release_id: "release-hidden-teaching",
        tags: ["preset:teaching"],
      },
    );
    const fallbackTeaching = image(
      "fallback-teaching",
      "cocalc.local/rootfs/fallback-teaching",
      {
        official: true,
        release_id: "release-fallback-teaching",
        tags: ["teaching"],
      },
    );
    const ctx = context({
      rootfsImages: [
        ...context().rootfsImages,
        hiddenTeaching,
        fallbackTeaching,
      ],
    });

    const draft = applyProjectPreset(
      createInitialProjectDraft(ctx),
      "teaching",
      ctx,
    );

    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("requires a managed image when no catalog image exists for ordinary users", () => {
    const draft = createInitialProjectDraft(
      context({
        rootfsImages: [],
        siteDefaultRootfs: undefined,
      }),
    );

    expect(draft.rootfs_image).toBe("");
    expect(
      projectDraftSummary(draft, context({ rootfsImages: [] })).warnings,
    ).toContain("Choose an image.");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("requires admins to explicitly choose custom OCI images", () => {
    const draft = createInitialProjectDraft(
      context({
        isAdmin: true,
        rootfsImages: [],
        siteDefaultRootfs: undefined,
      }),
    );

    expect(draft.rootfs_image).toBe("");
    expect(draft.rootfs_image_id).toBeUndefined();
  });

  it("keeps the selected region in create options", () => {
    const draft = setProjectDraftRegion(
      createInitialProjectDraft(context()),
      "weur" as R2Region,
      context(),
    );

    expect(projectDraftToCreateOptions(draft).region).toBe("weur");
  });
});
