import { extensionForContentType, pastedBlobFilename } from "../upload-utils";

test("maps image content types to useful file extensions", () => {
  expect(extensionForContentType("image/png")).toBe(".png");
  expect(extensionForContentType("image/jpeg")).toBe(".jpg");
  expect(extensionForContentType("image/svg+xml")).toBe(".svg");
  expect(extensionForContentType("application/octet-stream")).toBeUndefined();
});

test("pasted blob filenames preserve an image extension when available", () => {
  const filename = pastedBlobFilename("image/png");
  expect(filename).toMatch(/^paste-[a-z0-9]+\.png$/);
});
