/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

jest.mock("@cocalc/frontend/app-framework", () => ({}));
jest.mock("@cocalc/frontend/rootfs/manifest", () => ({}));
jest.mock("@cocalc/frontend/rootfs/catalog-ui", () => ({}));

import { recentProjectImagesFromMap } from "./use-project-create-draft";

const ME = "me";

test("recent images follow when *you* last used each project", () => {
  const projects = fromJS({
    old: {
      title: "Old",
      rootfs_image_id: "r",
      last_active: { [ME]: "2026-01-01" },
    },
    thesis: {
      title: "Thesis",
      rootfs_image_id: "sage",
      // A collaborator used it yesterday; that does not make it recent for me.
      last_active: { [ME]: "2026-06-01", other: "2026-10-03" },
    },
    stats: {
      title: "Stats",
      rootfs_image_id: "python",
      last_active: { [ME]: "2026-09-01" },
    },
    theirs: {
      title: "Theirs",
      rootfs_image_id: "latex",
      last_active: { other: "2026-10-04" },
    },
    gone: {
      title: "Gone",
      deleted: true,
      rootfs_image_id: "x",
      last_active: { [ME]: "2026-10-04" },
    },
    custom: { title: "Custom", last_active: { [ME]: "2026-10-04" } },
  });
  expect(
    recentProjectImagesFromMap(projects, ME).map(({ title }) => title),
  ).toEqual(["Stats", "Thesis", "Old"]);
});
