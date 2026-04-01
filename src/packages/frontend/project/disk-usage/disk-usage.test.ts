import { getStorageAnnotation, suggestFindSpaceSelection } from "./disk-usage";
import type { StorageVisibleSummary } from "./use-disk-usage";

function bucket(
  overrides: Partial<StorageVisibleSummary>,
): StorageVisibleSummary {
  return {
    key: "home",
    label: "/home/user",
    summaryLabel: "Home",
    path: "/home/user",
    summaryBytes: 100,
    usage: {
      path: "/home/user",
      bytes: 100,
      children: [],
      collected_at: "2026-03-31T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("disk usage find-space helpers", () => {
  it("prefers the current scratch folder when browsing inside scratch", () => {
    const visible: StorageVisibleSummary[] = [
      bucket({ key: "home", path: "/home/user" }),
      bucket({
        key: "scratch",
        label: "/scratch",
        path: "/scratch",
        summaryLabel: "Scratch",
      }),
    ];
    expect(suggestFindSpaceSelection(visible, "/scratch/build/cache")).toEqual({
      bucketKey: "scratch",
      path: "/scratch/build/cache",
    });
  });

  it("uses the current home folder when browsing inside home", () => {
    const visible: StorageVisibleSummary[] = [bucket({ path: "/home/user" })];
    expect(
      suggestFindSpaceSelection(visible, "/home/user/projects/cocalc"),
    ).toEqual({
      bucketKey: "home",
      path: "/home/user/projects/cocalc",
    });
  });

  it("annotates environment data under the home tree", () => {
    const annotation = getStorageAnnotation(
      bucket({ path: "/home/user" }),
      "/home/user/.local/share/cocalc/rootfs/docker.io/example",
    );
    expect(annotation?.label).toBe("Environment data");
    expect(annotation?.tone).toBe("warning");
  });

  it("annotates environment overlay paths in the environment bucket", () => {
    const annotation = getStorageAnnotation(
      bucket({
        key: "environment",
        label: "Environment changes",
        summaryLabel: "Environment",
        path: "/home/user/.local/share/cocalc/rootfs",
      }),
      "/home/user/.local/share/cocalc/rootfs/docker.io/example",
    );
    expect(annotation?.label).toBe("Environment overlay");
    expect(annotation?.tone).toBe("warning");
  });

  it("marks cache-like directories as reviewable cleanup targets", () => {
    const annotation = getStorageAnnotation(
      bucket({ path: "/home/user" }),
      "/home/user/.cache",
    );
    expect(annotation?.label).toBe("Cache-like data");
    expect(annotation?.tone).toBe("info");
  });
});
