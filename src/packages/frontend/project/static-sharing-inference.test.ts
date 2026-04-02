/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  inferStaticSharingFromDirectory,
  suggestAppIdFromDirectory,
  suggestStaticDirectoryFromProjectPath,
} from "./static-sharing-inference";

describe("static sharing inference", () => {
  test("prefers generic static when index.html is present", () => {
    expect(
      inferStaticSharingFromDirectory([
        { name: "index.html", size: 10, mtime: 1 },
        { name: "app.js", size: 10, mtime: 1 },
      ]),
    ).toMatchObject({
      hasIndexHtml: true,
      suggestions: [
        {
          key: "generic-static",
        },
      ],
    });
  });

  test("detects notes directories", () => {
    expect(
      inferStaticSharingFromDirectory([
        { name: "a.ipynb", size: 10, mtime: 1 },
        { name: "notes.md", size: 10, mtime: 1 },
      ]),
    ).toMatchObject({
      viewerFileTypes: [".md", ".ipynb"],
      suggestions: [
        {
          key: "public-notes",
        },
      ],
    });
  });

  test("detects slides directories", () => {
    expect(
      inferStaticSharingFromDirectory([
        { name: "deck.slides", size: 10, mtime: 1 },
        { name: "diagram.board", size: 10, mtime: 1 },
      ]),
    ).toMatchObject({
      viewerFileTypes: [".slides", ".board"],
      suggestions: [
        {
          key: "public-slides",
        },
      ],
    });
  });

  test("falls back to the mixed public viewer for mixed file types", () => {
    expect(
      inferStaticSharingFromDirectory([
        { name: "a.ipynb", size: 10, mtime: 1 },
        { name: "deck.slides", size: 10, mtime: 1 },
      ]),
    ).toMatchObject({
      viewerFileTypes: [".ipynb", ".slides"],
      suggestions: [
        {
          key: "cocalc-public-viewer",
        },
      ],
    });
  });

  test("uses the parent directory for likely file paths", () => {
    expect(
      suggestStaticDirectoryFromProjectPath(
        "/home/wstein/public-viewer/a.ipynb",
        "/home/wstein",
      ),
    ).toBe("/home/wstein/public-viewer");
  });

  test("slugs directory basenames into app ids", () => {
    expect(suggestAppIdFromDirectory("/home/wstein/My Public Viewer")).toBe(
      "my-public-viewer",
    );
  });
});
