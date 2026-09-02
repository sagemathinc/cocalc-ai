import getUrlTransform from "./url-transform";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";

describe("project page url transform", () => {
  it("leaves encoded cross-project anchors for SmartAnchorTag", () => {
    const transform = getUrlTransform({
      project_id: "1ce4fe78-19c7-40a8-a598-947975744cd9",
      path: "/home/user/a.md",
    });
    const href =
      `${window.location.origin}/projects/` +
      "756629fd-ce98-4596-8595-1071d6c019a6/files/home/user/scratch/a%20b.md";

    expect(transform(href, "a")).toBeUndefined();
  });

  it("keeps absolute slash paths unchanged", () => {
    const transform = getUrlTransform({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "tmp/x/a.chat",
    });
    expect(transform("/blobs/paste.png?uuid=123", "img")).toBe(
      "/blobs/paste.png?uuid=123",
    );
  });

  it("resolves relative image paths against current file directory", () => {
    const project_id = "00000000-1000-4000-8000-000000000000";
    const transform = getUrlTransform({
      project_id,
      path: "tmp/x/a.chat",
    });
    expect(transform("pics/p.png", "img")).toBe(
      fileURL({ project_id, path: "tmp/x/pics/p.png" }),
    );
  });

  it("rewrites absolute project image paths to file urls", () => {
    const project_id = "00000000-1000-4000-8000-000000000000";
    const transform = getUrlTransform({
      project_id,
      path: "tmp/x/a.chat",
    });
    expect(transform("/tmp/z/files-explorer-bottom.png", "img")).toBe(
      fileURL({ project_id, path: "tmp/z/files-explorer-bottom.png" }),
    );
  });
});
