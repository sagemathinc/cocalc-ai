import { isPartialUploadName, partialUploadPath } from "./partial-upload";

describe("partial upload names", () => {
  it("recognizes in-flight upload temp files", () => {
    expect(isPartialUploadName("DUE_DATE.txt.partialupload-7SFX86A7J5")).toBe(
      true,
    );
    expect(
      isPartialUploadName("Lab 2/DUE_DATE.txt.partialupload-KTGC9JBB9L"),
    ).toBe(true);
    expect(isPartialUploadName(partialUploadPath("a/b.ipynb", "x1"))).toBe(
      true,
    );
  });

  it("ignores ordinary names", () => {
    expect(isPartialUploadName("DUE_DATE.txt")).toBe(false);
    expect(isPartialUploadName(".partialupload-abc")).toBe(false);
    expect(isPartialUploadName("notes.partialupload-")).toBe(false);
    expect(isPartialUploadName("a.partialupload-x/inner.txt")).toBe(false);
  });
});
