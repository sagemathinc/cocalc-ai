import {
  extensionForContentType,
  initialPastedImageDimensions,
  pastedBlobFilename,
} from "../upload-utils";

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

test("retina pasted image dimensions are scaled to CSS pixels", () => {
  expect(
    initialPastedImageDimensions({
      filename: "paste-abc123.png",
      naturalWidth: 3200,
      naturalHeight: 2000,
      devicePixelRatio: 2,
    }),
  ).toEqual({
    width: "1600px",
    height: "1000px",
  });
});

test("non-pasted images do not get a forced initial size", () => {
  expect(
    initialPastedImageDimensions({
      filename: "photo.png",
      naturalWidth: 3200,
      naturalHeight: 2000,
      devicePixelRatio: 2,
    }),
  ).toBeUndefined();
});
