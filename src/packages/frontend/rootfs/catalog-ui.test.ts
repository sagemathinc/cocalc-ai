import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

import {
  groupRootfsVersionEntries,
  latestRootfsVersionForEntry,
  latestRootfsVersionEntries,
  latestRootfsUpgradeEntry,
} from "./catalog-ui";

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

  it("falls back to version recency if a supersedes chain loops", () => {
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

  it("does not infer a lineage without an explicit supersession edge", () => {
    const v11 = image("v1.1", "1.1");
    const v12 = image("v1.2", "1.2");
    const v13 = image("v1.3", "1.3");

    expect(
      latestRootfsUpgradeEntry({
        current: v11,
        images: [v12, v13],
      }),
    ).toBeUndefined();
  });

  it("does not pull an unlinked newer version into an explicit lineage", () => {
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
    ).toBe("v1.2");
  });

  it("rejects a non-official no-edge takeover of an official lineage", () => {
    const current = image("texlive-2026.08", "2026.08", {
      family: "texlive",
      official: true,
      owner_id: "758fc6ab-5d94-4304-af79-b873f3326cf3",
    });
    const attacker = image("attacker", "9999.99", {
      family: "texlive",
      label: "Totally Legit TeX 9999.99",
      official: false,
      owner_id: "different-owner",
      visibility: "public",
    });

    expect(groupRootfsVersionEntries([current, attacker])).toEqual([
      { latest: current, older: [] },
      { latest: attacker, older: [] },
    ]);
    expect(
      latestRootfsUpgradeEntry({
        current,
        images: [attacker],
      }),
    ).toBeUndefined();
  });

  it("follows an explicit supersession link across publishers", () => {
    const previous = image("previous", "1.0", {
      official: true,
      owner_id: "first-publisher",
    });
    const next = image("next", "2.0", {
      official: true,
      owner_id: "second-publisher",
      supersedes_image_id: previous.id,
    });

    expect(
      latestRootfsUpgradeEntry({ current: previous, images: [next] }),
    ).toBe(next);
  });

  it("does not suggest an older inferred release as an upgrade", () => {
    const current = image("current", "2.0");
    const older = image("older", "1.0");

    expect(
      latestRootfsUpgradeEntry({ current, images: [older] }),
    ).toBeUndefined();
  });

  it("does not suggest hidden or blocked lineage heads", () => {
    const current = image("current", "1.0");
    const hidden = image("hidden", "2.0", {
      hidden: true,
      supersedes_image_id: current.id,
    });
    const blocked = image("blocked", "3.0", {
      blocked: true,
      supersedes_image_id: current.id,
    });

    expect(
      latestRootfsUpgradeEntry({ current, images: [hidden, blocked] }),
    ).toBeUndefined();
  });
});

describe("rootfs catalog version groups", () => {
  it("keeps the newest version prominent and every older version available", () => {
    const unrelated = image("python", "3.14", {
      family: "python",
      label: "Python",
    });
    const v11 = image("v1.1", "1.1");
    const v19 = image("v1.9", "1.9", { supersedes_image_id: v11.id });
    const v20 = image("v2.0", "2.0", { supersedes_image_id: v19.id });

    expect(
      groupRootfsVersionEntries([v11, unrelated, v20, v19]).map((group) => ({
        latest: group.latest.id,
        older: group.older.map((entry) => entry.id),
      })),
    ).toEqual([
      { latest: "python", older: [] },
      { latest: "v2.0", older: ["v1.9", "v1.1"] },
    ]);
  });

  it("treats an unset channel as stable but keeps beta separate", () => {
    const stable = image("stable", "2.0", { channel: undefined });
    const beta = image("beta", "3.0", { channel: "beta" });
    const arm = image("arm", "4.0", {
      arch: ["arm64"],
      channel: "stable",
      supersedes_image_id: stable.id,
    });

    expect(
      groupRootfsVersionEntries([stable, beta, arm]).map((group) => ({
        latest: group.latest.id,
        older: group.older.map((entry) => entry.id),
      })),
    ).toEqual([
      { latest: "beta", older: [] },
      { latest: "arm", older: ["stable"] },
    ]);
  });

  it("groups the corrected production TeX Live releases across arch drift", () => {
    const texlive202607 = image(
      "0e795619-3dac-4efb-85ee-fd1766b97cc4",
      "2026.07",
      {
        arch: ["amd64"],
        family: "texlive",
        label: "Tex Live 2026",
        official: true,
        owner_id: "758fc6ab-5d94-4304-af79-b873f3326cf3",
      },
    );
    const texlive202608 = image(
      "99f5d4e1-8d09-4c20-8edd-374b6df20a0c",
      "2026.08",
      {
        arch: ["any"],
        family: "texlive",
        label: "Tex Live 2026",
        official: true,
        owner_id: "758fc6ab-5d94-4304-af79-b873f3326cf3",
        supersedes_image_id: texlive202607.id,
      },
    );

    expect(groupRootfsVersionEntries([texlive202607, texlive202608])).toEqual([
      { latest: texlive202608, older: [texlive202607] },
    ]);
    expect(
      latestRootfsUpgradeEntry({
        current: texlive202607,
        images: [texlive202608],
      }),
    ).toBe(texlive202608);
    expect(
      latestRootfsVersionForEntry({
        current: texlive202607,
        images: [texlive202607, texlive202608],
      }),
    ).toBe(texlive202608);
  });

  it("keeps the historical TeX Live official-status mistake separate", () => {
    const owner_id = "758fc6ab-5d94-4304-af79-b873f3326cf3";
    const texlive202607 = image("texlive-2026.07", "2026.07", {
      arch: ["amd64"],
      family: "texlive",
      official: true,
      owner_id,
    });
    const malformed202608 = image("texlive-2026.08-malformed", "2026.08", {
      arch: ["any"],
      family: "texlive",
      official: false,
      owner_id,
      supersedes_image_id: texlive202607.id,
    });

    expect(groupRootfsVersionEntries([texlive202607, malformed202608])).toEqual(
      [
        { latest: texlive202607, older: [] },
        { latest: malformed202608, older: [] },
      ],
    );
    expect(
      latestRootfsUpgradeEntry({
        current: texlive202607,
        images: [malformed202608],
      }),
    ).toBeUndefined();
  });

  it("groups a family when version numbers are included in its labels", () => {
    const python313 = image("python-3.13", "3.13", {
      family: "python",
      label: "Python 3.13",
    });
    const python314 = image("python-3.14", "3.14", {
      family: "python",
      label: "Python 3.14",
      supersedes_image_id: python313.id,
    });

    expect(groupRootfsVersionEntries([python313, python314])).toEqual([
      { latest: python314, older: [python313] },
    ]);
  });

  it("does not let explicit supersession cross family boundaries", () => {
    const previous = image("old", "1.0", {
      created: "2026-01-01T00:00:00Z",
      family: "python-classic",
      label: "Classic Python",
      owner_id: "publisher",
    });
    const latest = image("new", "2.0", {
      created: "2026-02-01T00:00:00Z",
      family: "python",
      label: "Python Scientific",
      owner_id: "publisher",
      supersedes_image_id: previous.id,
    });

    expect(groupRootfsVersionEntries([previous, latest])).toEqual([
      { latest: previous, older: [] },
      { latest, older: [] },
    ]);
  });

  it("rejects a cross-owner community supersession edge", () => {
    const bob = image("bob-img", "1.0", {
      official: false,
      owner_id: "bob",
    });
    const eve = image("eve-img", "9.9", {
      official: false,
      owner_id: "eve",
      supersedes_image_id: bob.id,
    });

    expect(groupRootfsVersionEntries([bob, eve])).toEqual([
      { latest: bob, older: [] },
      { latest: eve, older: [] },
    ]);
    expect(
      latestRootfsUpgradeEntry({ current: bob, images: [eve] }),
    ).toBeUndefined();
  });

  it("allows a same-owner community supersession edge", () => {
    const previous = image("previous", "1.0", {
      official: false,
      owner_id: " Community Publisher ",
    });
    const next = image("next", "2.0", {
      official: false,
      owner_id: "community publisher",
      supersedes_image_id: previous.id,
    });

    expect(groupRootfsVersionEntries([previous, next])).toEqual([
      { latest: next, older: [previous] },
    ]);
  });

  it("allows an official lineage edge across publisher identities", () => {
    const previous = image("previous", "1.0", {
      official: true,
      owner_id: "first-publisher",
    });
    const next = image("next", "2.0", {
      official: true,
      owner_id: "second-publisher",
      supersedes_image_id: previous.id,
    });

    expect(
      groupRootfsVersionEntries([previous, next]).map((group) => ({
        latest: group.latest.id,
        older: group.older.map((entry) => entry.id),
      })),
    ).toEqual([{ latest: "next", older: ["previous"] }]);
  });

  it("keeps an explicit cross-family successor in its own lineage", () => {
    const python = image("python-314", "3.14", {
      created: "2026-01-01T00:00:00Z",
      family: "python",
      owner_id: "publisher",
    });
    const sage = image("sage-109", "10.9", {
      created: "2026-02-01T00:00:00Z",
      family: "sagemath",
      owner_id: "publisher",
      supersedes_image_id: python.id,
    });

    expect(groupRootfsVersionEntries([python, sage])).toEqual([
      { latest: python, older: [] },
      { latest: sage, older: [] },
    ]);
  });

  it("does not let explicit supersession cross channel, GPU, or official boundaries", () => {
    const stableCpu = image("stable-cpu", "1.0");
    const betaCpu = image("beta-cpu", "2.0", {
      channel: "beta",
      supersedes_image_id: stableCpu.id,
    });
    const stableGpu = image("stable-gpu", "3.0", {
      gpu: true,
      supersedes_image_id: stableCpu.id,
    });
    const officialCpu = image("official-cpu", "4.0", {
      official: true,
      supersedes_image_id: stableCpu.id,
    });

    expect(
      groupRootfsVersionEntries([
        stableCpu,
        betaCpu,
        stableGpu,
        officialCpu,
      ]).map((group) => ({
        latest: group.latest.id,
        older: group.older.map((entry) => entry.id),
      })),
    ).toEqual([
      { latest: "stable-cpu", older: [] },
      { latest: "beta-cpu", older: [] },
      { latest: "stable-gpu", older: [] },
      { latest: "official-cpu", older: [] },
    ]);
    expect(
      latestRootfsUpgradeEntry({
        current: stableCpu,
        images: [betaCpu, stableGpu, officialCpu],
      }),
    ).toBeUndefined();
  });

  it("keeps unversioned entries visible in in-app pickers", () => {
    const previous = image("previous", "", {
      family: undefined,
      version: undefined,
    });
    const next = image("next", "", {
      family: undefined,
      supersedes_image_id: previous.id,
      version: undefined,
    });

    expect(latestRootfsVersionEntries([previous, next])).toEqual([
      previous,
      next,
    ]);
  });
});
