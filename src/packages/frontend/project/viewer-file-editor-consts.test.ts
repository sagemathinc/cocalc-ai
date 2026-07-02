import { shouldUsePublicViewerFileEditor } from "./viewer-file-editor-consts";
import { viewerRawFileUrl } from "./viewer-file-editor";

test("routes html through the public viewer file editor", () => {
  expect(shouldUsePublicViewerFileEditor("html")).toBe(true);
  expect(shouldUsePublicViewerFileEditor("HTML")).toBe(true);
});

test("does not route ordinary source files through the public viewer file editor", () => {
  expect(shouldUsePublicViewerFileEditor("py")).toBe(false);
});

test("adds public share context to viewer raw file urls", () => {
  const url = viewerRawFileUrl({
    project_id: "00000000-1000-4000-8000-000000000001",
    path: "/home/user/public/Figure 4.html",
    share_id: "00000000-1000-4000-8000-000000000002",
  });
  expect(url).toContain("viewer=1");
  expect(url).toContain("share=00000000-1000-4000-8000-000000000002");
  expect(url).toContain("Figure%204.html");
});

test("adds viewer context to non-share viewer raw file urls", () => {
  expect(
    viewerRawFileUrl({
      project_id: "00000000-1000-4000-8000-000000000001",
      path: "/home/user/public/Figure4.html",
      viewer: true,
    }),
  ).toContain("viewer=1");
});
