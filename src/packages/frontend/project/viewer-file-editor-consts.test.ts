import { shouldUsePublicViewerFileEditor } from "./viewer-file-editor-consts";

test("routes html through the public viewer file editor", () => {
  expect(shouldUsePublicViewerFileEditor("html")).toBe(true);
  expect(shouldUsePublicViewerFileEditor("HTML")).toBe(true);
});

test("does not route ordinary source files through the public viewer file editor", () => {
  expect(shouldUsePublicViewerFileEditor("py")).toBe(false);
});
