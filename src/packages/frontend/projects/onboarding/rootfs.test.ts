import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { chooseOnboardingRootfs, quickProjectImageChoices } from "./rootfs";

function image(
  id: string,
  tags: string[],
  extra: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    image: `registry/${id}:1`,
    label: id,
    release_id: `release-${id}`,
    tags,
    ...extra,
  };
}

describe("chooseOnboardingRootfs", () => {
  it("prefers the namespaced onboarding tag", () => {
    const result = chooseOnboardingRootfs({
      kind: "latex",
      images: [
        image("generic", ["latex"], { official: true, priority: 100 }),
        image("onboarding", ["onboarding:latex"], { official: true }),
      ],
    });
    expect(result?.image_id).toBe("onboarding");
    expect(result?.matched_tag).toBe("onboarding:latex");
  });

  it("never selects a non-official image from onboarding tags", () => {
    const result = chooseOnboardingRootfs({
      kind: "latex",
      images: [image("community", ["onboarding:latex"])],
      fallback: { image: "registry/default:1", image_id: "default" },
    });
    expect(result).toEqual({
      image: "registry/default:1",
      image_id: "default",
    });
  });

  it("prefers non-deprecated official images within a tag", () => {
    const result = chooseOnboardingRootfs({
      kind: "code",
      images: [
        image("deprecated", ["onboarding:code"], {
          deprecated: true,
          official: true,
          priority: 100,
        }),
        image("community", ["onboarding:code"], { priority: 50 }),
        image("official", ["onboarding:code"], { official: true }),
      ],
    });
    expect(result?.image_id).toBe("official");
  });

  it("rejects unavailable tagged images and preserves the fallback", () => {
    const result = chooseOnboardingRootfs({
      kind: "sage",
      images: [image("blocked", ["onboarding:sage"], { blocked: true })],
      fallback: { image: "registry/default:1", image_id: "default" },
    });
    expect(result).toEqual({
      image: "registry/default:1",
      image_id: "default",
    });
  });

  it("returns a catalog fallback when no onboarding tags are configured", () => {
    const entry = image("standard", [], { official: true });
    const result = chooseOnboardingRootfs({
      kind: "codex",
      images: [entry],
      fallback: { image: entry.image, image_id: entry.id },
    });
    expect(result?.entry).toBe(entry);
    expect(result?.matched_tag).toBeUndefined();
  });
});

describe("quick project image choices", () => {
  it("offers Python, R, SageMath and LaTeX only for images clearly made for them", () => {
    const choices = quickProjectImageChoices({
      images: [
        image("py", ["onboarding:jupyter-python"], { official: true }),
        image("r", ["r", "jupyter"], { official: true }),
        image("sage", ["sagemath"], { official: true }),
        // Only generic tags: not offered as LaTeX (or anything else).
        image("everything", ["jupyter", "preset:standard"], { official: true }),
        // Not official: never offered.
        image("tex", ["latex"]),
      ],
    });
    expect(choices.map(({ label, entry }) => [label, entry.id])).toEqual([
      ["Python", "py"],
      ["R", "r"],
      ["SageMath", "sage"],
    ]);
  });

  it("offers each image once", () => {
    const choices = quickProjectImageChoices({
      images: [image("sage", ["sagemath", "latex"], { official: true })],
    });
    expect(choices.map(({ label }) => label)).toEqual(["SageMath"]);
  });
});
