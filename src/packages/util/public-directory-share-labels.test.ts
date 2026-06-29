/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  publicDirectoryShareIndicatorsForPath,
  publicDirectoryShareLabelsFromProjectLabels,
  publicDirectoryShareProjectLabelKey,
  publicDirectoryShareProjectLabelValue,
} from "./public-directory-share-labels";

describe("public directory share project labels", () => {
  it("encodes and parses active share metadata", () => {
    const key = publicDirectoryShareProjectLabelKey(
      "11111111-1111-4111-8111-111111111111",
    );
    const value = publicDirectoryShareProjectLabelValue({
      path: "/home/user/docs",
      slug: "course/docs",
      title: "Course Docs",
      requires_auth: true,
      visibility: "unlisted",
    });

    expect(value).not.toBeNull();
    expect(
      publicDirectoryShareLabelsFromProjectLabels({ [key]: value }),
    ).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        path: "docs",
        slug: "course/docs",
        title: "Course Docs",
        requires_auth: true,
        visibility: "unlisted",
        whole_project: false,
      },
    ]);
  });

  it("classifies direct, descendant, and ancestor publication paths", () => {
    const labels = publicDirectoryShareLabelsFromProjectLabels({
      [publicDirectoryShareProjectLabelKey(
        "11111111-1111-4111-8111-111111111111",
      )]: publicDirectoryShareProjectLabelValue({
        path: "docs",
        slug: "docs",
      }),
      [publicDirectoryShareProjectLabelKey(
        "22222222-2222-4222-8222-222222222222",
      )]: publicDirectoryShareProjectLabelValue({
        path: "docs/examples",
        slug: "examples",
      }),
    });

    expect(
      publicDirectoryShareIndicatorsForPath({ labels, path: "docs" }),
    ).toMatchObject({
      direct: [{ path: "docs" }],
      descendants: [{ path: "docs/examples" }],
      ancestors: [],
    });
    expect(
      publicDirectoryShareIndicatorsForPath({
        labels,
        path: "docs/examples/a.txt",
      }),
    ).toMatchObject({
      direct: [],
      descendants: [],
      ancestors: [{ path: "docs" }, { path: "docs/examples" }],
    });
  });
});
