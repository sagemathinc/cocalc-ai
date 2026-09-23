import { blobImageUrl } from "./theme-image-url";

test("theme blob URLs remain on the current origin without an app base path", () => {
  expect(blobImageUrl(" 1234 ")).toBe("/blobs/theme-image.png?uuid=1234");
  expect(blobImageUrl("")).toBeUndefined();
});
