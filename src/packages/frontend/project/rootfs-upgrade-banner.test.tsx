/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";

import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

import {
  getProjectRootfsUpgrade,
  isRootfsUpgradeDismissed,
  normalizeRootfsUpgradeDismissals,
  ProjectRootfsUpgradeAlert,
  withRootfsUpgradeDismissal,
} from "./rootfs-upgrade-banner";

jest.mock("@cocalc/frontend/project/settings/root-filesystem-image", () => ({
  RootFilesystemImageModal: () => null,
}));

function image(
  id: string,
  version: string,
  opts: Partial<RootfsImageEntry> = {},
): RootfsImageEntry {
  return {
    id,
    image: `cocalc.local/rootfs/${id}`,
    label: "CoCalc Basic",
    family: "ubuntu",
    version,
    channel: "stable",
    ...opts,
  };
}

describe("getProjectRootfsUpgrade", () => {
  it("finds the current catalog entry by id and returns its latest upgrade", () => {
    const current = image("basic-1.6", "1.6");
    const next = image("basic-1.7", "1.7", {
      supersedes_image_id: current.id,
    });

    expect(
      getProjectRootfsUpgrade({
        imageId: current.id,
        images: [current, next],
      }),
    ).toEqual({ current, next });
  });

  it("falls back to the runtime image name for projects without an image id", () => {
    const current = image("basic-1.6", "1.6");
    const next = image("basic-1.7", "1.7", {
      supersedes_image_id: current.id,
    });

    expect(
      getProjectRootfsUpgrade({
        image: current.image,
        images: [current, next],
      })?.next.id,
    ).toBe(next.id);
  });
});

describe("RootFS upgrade dismissal settings", () => {
  it("normalizes server-backed Immutable account settings", () => {
    expect(
      normalizeRootfsUpgradeDismissals(
        fromJS({ "project-1": "basic-1.7", invalid: 17 }),
      ),
    ).toEqual({ "project-1": "basic-1.7" });
  });

  it("preserves other project dismissals when recording a target", () => {
    expect(
      withRootfsUpgradeDismissal({
        dismissals: { "project-1": "basic-1.7" },
        project_id: "project-2",
        targetImageId: "sage-10.9",
      }),
    ).toEqual({
      "project-1": "basic-1.7",
      "project-2": "sage-10.9",
    });
  });

  it("dismisses only the recorded target, not a future upgrade", () => {
    const dismissals = { "project-1": "basic-1.7" };
    expect(
      isRootfsUpgradeDismissed({
        dismissals,
        project_id: "project-1",
        targetImageId: "basic-1.7",
      }),
    ).toBe(true);
    expect(
      isRootfsUpgradeDismissed({
        dismissals,
        project_id: "project-1",
        targetImageId: "basic-1.8",
      }),
    ).toBe(false);
  });
});

describe("ProjectRootfsUpgradeAlert", () => {
  it("opens the review flow and explains permanent dismissal", () => {
    const current = image("basic-1.6", "1.6");
    const next = image("basic-1.7", "1.7");
    const onDismiss = jest.fn();
    const onReview = jest.fn();
    const { rerender } = render(
      <ProjectRootfsUpgradeAlert
        current={current}
        dismissed={false}
        next={next}
        onDismiss={onDismiss}
        onReview={onReview}
      />,
    );

    fireEvent.click(screen.getByText("Review upgrade"));
    expect(onReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.getByText("Stop showing this upgrade?")).toBeTruthy();
    expect(
      screen.getByText(
        "You can still upgrade later using the Image button on the left side of the project, or Upgrade in the Projects list.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Dismiss permanently"));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(
      <ProjectRootfsUpgradeAlert
        current={current}
        dismissed
        next={next}
        onDismiss={onDismiss}
        onReview={onReview}
      />,
    );
    expect(screen.queryByText("A newer project image is available")).toBeNull();
  });
});
