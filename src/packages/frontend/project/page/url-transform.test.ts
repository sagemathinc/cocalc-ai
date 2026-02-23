import getUrlTransform from "./url-transform";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";

describe("project page url transform", () => {
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
});

